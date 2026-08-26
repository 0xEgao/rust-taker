//! Managed-Tor fallback, ported from `taker-app/tor-manager/src/main.rs` — folded in-process
//! instead of a separate spawned sidecar binary, since this app has no daemon/subprocess split
//! elsewhere (see CLAUDE.md's "embedded in-process, not a daemon" note).
//!
//! `ensure_tor` tries, in order: an already-running Tor (system service, Tor Browser, ...) →
//! a `tor` binary found on PATH/common install paths, spawned with a generated torrc → an
//! embedded Tor compiled in via `libtor` (only when built with `--features embedded-tor`).
//! Callers run this before their own control-port handshake, so that handshake succeeds because
//! something is now listening — it does not replace that handshake's auth/bootstrap reporting.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const READINESS_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// The Tor tier selected by managed startup.
pub enum TorSource {
    /// Something was already listening on both ports — nothing spawned.
    System,
    /// A `tor` binary found on the host was spawned; `ensure_tor` returns its `Child`.
    HostBinary,
    /// Compiled-in Tor started on a background thread — no child process to track.
    Embedded,
    /// Nothing reachable and no fallback succeeded (or `COINSWAP_DISABLE_MANAGED_TOR=1`).
    None,
}

impl TorSource {
    /// Stable value serialized into setup status responses.
    pub fn as_str(self) -> &'static str {
        match self {
            TorSource::System => "system",
            TorSource::HostBinary => "host_binary",
            TorSource::Embedded => "embedded",
            TorSource::None => "none",
        }
    }
}

/// Performs a bounded SOCKS5 greeting against a loopback port.
pub fn socks5_responds(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(700)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(&[0x05, 0x01, 0x00]).is_err() {
        return false;
    }
    let mut response = [0u8; 2];
    stream.read_exact(&mut response).is_ok() && response[0] == 0x05 && response[1] != 0xff
}

fn control_responds_as_tor(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(700)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(b"PROTOCOLINFO 1\r\n").is_err() {
        return false;
    }
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).is_ok() && line.starts_with("250-PROTOCOLINFO")
}

fn ports_are_tor(socks_port: u16, control_port: u16) -> bool {
    socks5_responds(socks_port) && control_responds_as_tor(control_port)
}

fn wait_until_ready(socks_port: u16, control_port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if ports_are_tor(socks_port, control_port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

fn find_host_tor() -> Option<PathBuf> {
    let executable = if cfg!(windows) { "tor.exe" } else { "tor" };
    let search_path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&search_path)
        .map(|directory| directory.join(executable))
        .chain(common_tor_paths().into_iter().map(PathBuf::from))
        .find(|path| safe_tor_binary(path))
}

fn safe_tor_binary(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o022 != 0 {
            return false;
        }
    }
    true
}

fn common_tor_paths() -> Vec<&'static str> {
    if cfg!(target_os = "macos") {
        vec![
            "/opt/homebrew/bin/tor",
            "/usr/local/bin/tor",
            "/usr/bin/tor",
            "/opt/local/bin/tor",
        ]
    } else if cfg!(windows) {
        vec![
            r"C:\Program Files\Tor\tor.exe",
            r"C:\Program Files (x86)\Tor\tor.exe",
        ]
    } else {
        vec!["/usr/bin/tor", "/usr/local/bin/tor", "/bin/tor"]
    }
}

fn data_dir_path(tor_dir: &Path) -> PathBuf {
    tor_dir.join("data")
}

fn cookie_path(tor_dir: &Path) -> PathBuf {
    data_dir_path(tor_dir).join("control_auth_cookie")
}

fn managed_tor_dir() -> Result<PathBuf, String> {
    coinswap::utill::get_taker_dir()
        .map(|dir| dir.join("tor-manager"))
        .map_err(|e| e.to_string())
}

/// Reads and validates the managed Tor control cookie without following symlinks.
pub fn managed_cookie() -> Result<Vec<u8>, String> {
    let path = cookie_path(&managed_tor_dir()?);
    let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("control cookie is not a regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("control cookie is accessible by another local account".to_string());
        }
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() != 32 {
        return Err("control cookie has an invalid length".to_string());
    }
    Ok(bytes)
}

fn write_torrc(tor_dir: &Path, socks_port: u16, control_port: u16) -> std::io::Result<PathBuf> {
    let data_dir = data_dir_path(tor_dir);
    let cookie = cookie_path(tor_dir);
    if [data_dir.as_path(), cookie.as_path()].iter().any(|path| {
        path.to_string_lossy()
            .chars()
            .any(|character| matches!(character, '\r' | '\n'))
    }) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "managed Tor paths cannot contain CR or LF",
        ));
    }
    crate::security::fs::ensure_private_dir(tor_dir)
        .map_err(|e| std::io::Error::other(e.message))?;
    crate::security::fs::ensure_private_dir(&data_dir)
        .map_err(|e| std::io::Error::other(e.message))?;
    let quoted = data_dir
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let quoted_cookie = cookie
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let torrc = format!(
        "SocksPort 127.0.0.1:{socks_port}\nControlPort 127.0.0.1:{control_port}\nCookieAuthentication 1\nCookieAuthFile \"{quoted_cookie}\"\nCookieAuthFileGroupReadable 0\nDataDirectory \"{quoted}\"\n"
    );
    let path = tor_dir.join("torrc");
    crate::security::fs::write_private(&path, torrc.as_bytes())
        .map_err(|e| std::io::Error::other(e.message))?;
    Ok(path)
}

fn start_host_tor(
    tor_dir: &Path,
    tor_bin: &Path,
    socks_port: u16,
    control_port: u16,
) -> std::io::Result<Child> {
    let torrc = write_torrc(tor_dir, socks_port, control_port)?;
    let child = Command::new(tor_bin)
        .arg("-f")
        .arg(torrc)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    if wait_until_ready(socks_port, control_port, READINESS_TIMEOUT) {
        Ok(child)
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "tor did not open SOCKS/control ports in time",
        ))
    }
}

#[cfg(feature = "embedded-tor")]
fn start_embedded_tor(tor_dir: &Path, socks_port: u16, control_port: u16) -> Result<(), String> {
    use libtor::{Tor, TorBool, TorFlag};

    let data_dir = data_dir_path(tor_dir);
    crate::security::fs::ensure_private_dir(tor_dir).map_err(|e| e.message)?;
    crate::security::fs::ensure_private_dir(&data_dir).map_err(|e| e.message)?;
    let cookie = cookie_path(tor_dir);

    let mut tor = Tor::new();
    tor.flag(TorFlag::DataDirectory(
        data_dir.to_string_lossy().to_string(),
    ))
    .flag(TorFlag::SocksPort(socks_port))
    .flag(TorFlag::ControlPort(control_port))
    .flag(TorFlag::CookieAuthentication(TorBool::from(true)))
    .flag(TorFlag::CookieAuthFile(
        cookie.to_string_lossy().to_string(),
    ))
    .flag(TorFlag::CookieAuthFileGroupReadable(TorBool::from(false)))
    .flag(TorFlag::Hush());

    let handle = tor.start_background();
    if wait_until_ready(socks_port, control_port, READINESS_TIMEOUT) {
        std::thread::spawn(move || match handle.join() {
            Ok(Ok(code)) => log::info!("embedded tor exited with code {code}"),
            Ok(Err(e)) => log::warn!("embedded tor error: {e:?}"),
            Err(_) => log::warn!("embedded tor thread panicked"),
        });
        Ok(())
    } else {
        Err("embedded tor did not open SOCKS/control ports in time".to_string())
    }
}

#[cfg(not(feature = "embedded-tor"))]
fn start_embedded_tor(_tor_dir: &Path, _socks_port: u16, _control_port: u16) -> Result<(), String> {
    Err("embedded Tor support was not compiled in (build with --features embedded-tor)".to_string())
}

/// Ensures something is listening on `socks_port`/`control_port`, falling back through
/// system → host binary → embedded. Returns the source used and, for `HostBinary`, the spawned
/// `Child` so the caller can keep it alive and kill it on app exit.
pub fn ensure_tor(socks_port: u16, control_port: u16) -> (TorSource, Option<Child>) {
    if std::env::var("COINSWAP_DISABLE_MANAGED_TOR").as_deref() == Ok("1") {
        return (TorSource::None, None);
    }
    if ports_are_tor(socks_port, control_port) {
        return (TorSource::System, None);
    }

    let tor_dir = match coinswap::utill::get_taker_dir() {
        Ok(dir) => dir.join("tor-manager"),
        Err(e) => {
            log::warn!("could not resolve taker data dir: {e}");
            return (TorSource::None, None);
        }
    };
    if let Err(e) = crate::security::fs::ensure_private_dir(&tor_dir) {
        log::warn!(
            "could not create tor-manager config dir {}: {e:?}",
            tor_dir.display()
        );
    }

    if let Some(tor_bin) = find_host_tor() {
        match start_host_tor(&tor_dir, &tor_bin, socks_port, control_port) {
            Ok(child) => return (TorSource::HostBinary, Some(child)),
            Err(e) => log::warn!("host tor at {} failed to start: {e}", tor_bin.display()),
        }
    } else {
        log::info!("no host tor binary found on PATH or common install locations");
    }

    match start_embedded_tor(&tor_dir, socks_port, control_port) {
        Ok(()) => (TorSource::Embedded, None),
        Err(e) => {
            log::warn!("embedded tor failed to start: {e}");
            (TorSource::None, None)
        }
    }
}
