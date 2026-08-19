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
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const READINESS_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    pub fn as_str(self) -> &'static str {
        match self {
            TorSource::System => "system",
            TorSource::HostBinary => "host_binary",
            TorSource::Embedded => "embedded",
            TorSource::None => "none",
        }
    }
}

fn tcp_reachable(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(700)).is_ok()
}

fn ports_reachable(socks_port: u16, control_port: u16) -> bool {
    tcp_reachable(socks_port) && tcp_reachable(control_port)
}

fn wait_until_ready(socks_port: u16, control_port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if ports_reachable(socks_port, control_port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

fn find_host_tor() -> Option<PathBuf> {
    let lookup_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = Command::new(lookup_cmd).arg("tor").output() {
        if output.status.success() {
            if let Some(first_line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                let candidate = PathBuf::from(first_line.trim());
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    common_tor_paths().into_iter().map(PathBuf::from).find(|p| p.is_file())
}

fn common_tor_paths() -> Vec<&'static str> {
    if cfg!(target_os = "macos") {
        vec!["/opt/homebrew/bin/tor", "/usr/local/bin/tor", "/usr/bin/tor", "/opt/local/bin/tor"]
    } else if cfg!(windows) {
        vec![r"C:\Program Files\Tor\tor.exe", r"C:\Program Files (x86)\Tor\tor.exe"]
    } else {
        vec!["/usr/bin/tor", "/usr/local/bin/tor", "/bin/tor"]
    }
}

fn data_dir_path(tor_dir: &Path) -> PathBuf {
    tor_dir.join("data")
}

fn write_torrc(tor_dir: &Path, socks_port: u16, control_port: u16) -> std::io::Result<PathBuf> {
    let data_dir = data_dir_path(tor_dir);
    fs::create_dir_all(&data_dir)?;
    // CookieAuthentication 0 — no-auth control port, matching the empty tor_auth_password this
    // app's own connectivity defaults ship (see connectivity.ts's HARDCODED_DEFAULTS).
    let quoted = data_dir.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    let torrc = format!(
        "SocksPort 127.0.0.1:{socks_port}\nControlPort 127.0.0.1:{control_port}\nCookieAuthentication 0\nDataDirectory \"{quoted}\"\n"
    );
    let path = tor_dir.join("torrc");
    fs::write(&path, torrc)?;
    Ok(path)
}

fn start_host_tor(tor_dir: &Path, tor_bin: &Path, socks_port: u16, control_port: u16) -> std::io::Result<Child> {
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
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let mut tor = Tor::new();
    tor.flag(TorFlag::DataDirectory(data_dir.to_string_lossy().to_string()))
        .flag(TorFlag::SocksPort(socks_port))
        .flag(TorFlag::ControlPort(control_port))
        .flag(TorFlag::CookieAuthentication(TorBool::from(false)))
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
    if ports_reachable(socks_port, control_port) {
        return (TorSource::System, None);
    }

    let tor_dir = match coinswap::utill::get_taker_dir() {
        Ok(dir) => dir.join("tor-manager"),
        Err(e) => {
            log::warn!("could not resolve taker data dir: {e}");
            return (TorSource::None, None);
        }
    };
    if let Err(e) = fs::create_dir_all(&tor_dir) {
        log::warn!("could not create tor-manager config dir {}: {e}", tor_dir.display());
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
