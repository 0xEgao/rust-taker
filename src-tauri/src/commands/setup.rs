//! Setup & connectivity commands: wizard prechecks and version info.
//! All blocking I/O runs via `spawn_blocking` — never on the async runtime.
//! Wallet lifecycle (init/restore/backup) lives in `commands::taker_wallet`.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::error::AppError;
use crate::types::{TorStatus, VersionInfo};

#[tauri::command]
pub fn get_version_info(app: tauri::AppHandle) -> VersionInfo {
    VersionInfo {
        app_version: app.package_info().version.to_string(),
        coinswap_source: format!("git {}", env!("PORTAL_COINSWAP_REV")),
    }
}

/// Starts Portal's own Tor if it isn't up yet, then mirrors coinswap's control-port
/// handshake against it. Bootstrap < 100% is informational only, not a failure.
#[tauri::command]
pub async fn check_tor() -> Result<TorStatus, AppError> {
    tauri::async_runtime::spawn_blocking(|| match crate::tor::ensure_tor() {
        Ok(runtime) => run_tor_handshake(&runtime),
        Err(error) => TorStatus {
            reachable: false,
            socks_reachable: false,
            authenticated: false,
            bootstrap_progress: None,
            error: Some(error),
            socks_port: None,
            control_port: None,
        },
    })
    .await
    .map_err(AppError::internal)
}

fn run_tor_handshake(tor: &crate::tor::TorRuntime) -> TorStatus {
    let (socks_port, control_port) = (tor.socks_port, tor.control_port);
    let unreachable = |socks_reachable: bool, err: String| TorStatus {
        reachable: false,
        socks_reachable,
        authenticated: false,
        bootstrap_progress: None,
        error: Some(err),
        socks_port: Some(socks_port),
        control_port: Some(control_port),
    };

    if !crate::tor::socks5_responds(socks_port) {
        return unreachable(
            false,
            "configured SOCKS port did not complete a SOCKS5 greeting".into(),
        );
    }

    let addr = match format!("127.0.0.1:{control_port}").to_socket_addrs() {
        Ok(mut addrs) => match addrs.next() {
            Some(a) => a,
            None => return unreachable(true, "could not resolve control port address".into()),
        },
        Err(e) => return unreachable(true, e.to_string()),
    };

    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
        Ok(s) => s,
        Err(e) => return unreachable(true, e.to_string()),
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let mut reader = match stream.try_clone() {
        Ok(s) => BufReader::new(s),
        Err(e) => return unreachable(true, e.to_string()),
    };

    if stream.write_all(b"PROTOCOLINFO 1\r\n").is_err() {
        return unreachable(true, "failed to send PROTOCOLINFO".into());
    }
    let mut protocol_lines = Vec::new();
    for _ in 0..32 {
        let mut line = String::new();
        let read = (&mut reader).take(8193).read_line(&mut line);
        if !matches!(read, Ok(1..=8192)) || !line.ends_with('\n') {
            return unreachable(true, "invalid Tor PROTOCOLINFO response".into());
        }
        let done = line.starts_with("250 OK");
        protocol_lines.push(line);
        if done {
            break;
        }
    }
    if protocol_lines.is_empty()
        || !protocol_lines[0].starts_with("250-PROTOCOLINFO")
        || !protocol_lines
            .last()
            .is_some_and(|line| line.starts_with("250 OK"))
    {
        return unreachable(true, "control port did not identify itself as Tor".into());
    }

    // Same quoted form the crate uses, so a failure here means the maker's ADD_ONION
    // would fail the same way rather than passing this check and breaking later.
    let command = format!("AUTHENTICATE \"{}\"\r\n", tor.control_password);
    if stream.write_all(command.as_bytes()).is_err() {
        return unreachable(true, "failed to send AUTHENTICATE".into());
    }
    let mut resp = String::new();
    if reader.read_line(&mut resp).is_err() || !resp.starts_with("250") {
        return TorStatus {
            reachable: true,
            socks_reachable: true,
            authenticated: false,
            bootstrap_progress: None,
            error: Some("Tor control-port authentication failed".into()),
            socks_port: Some(socks_port),
            control_port: Some(control_port),
        };
    }

    if stream
        .write_all(b"GETINFO status/bootstrap-phase\r\n")
        .is_err()
    {
        return TorStatus {
            reachable: true,
            socks_reachable: true,
            authenticated: true,
            bootstrap_progress: None,
            error: None,
            socks_port: Some(socks_port),
            control_port: Some(control_port),
        };
    }
    resp.clear();
    let _ = reader.read_line(&mut resp);
    let bootstrap_progress = resp
        .split("PROGRESS=")
        .nth(1)
        .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|s| s.parse::<u8>().ok());

    TorStatus {
        reachable: true,
        socks_reachable: true,
        authenticated: true,
        bootstrap_progress,
        error: None,
        socks_port: Some(socks_port),
        control_port: Some(control_port),
    }
}

