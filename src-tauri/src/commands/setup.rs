//! Setup & connectivity commands: wizard prechecks and version info.
//! All blocking I/O runs via `spawn_blocking` — never on the async runtime.
//! Wallet lifecycle (init/restore/backup) lives in `commands::taker_wallet`.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::error::AppError;
use crate::security::input::validate_tor_control_secret;
use crate::state::AppState;
use crate::types::{PortStatus, TorStatus, VersionInfo};

/// Purpose-specific Core ZMQ reachability check. Portal only supports a local
/// endpoint; remote users must expose it through a trusted local tunnel.
#[tauri::command]
pub async fn check_core_zmq(host: String, port: u16) -> Result<PortStatus, AppError> {
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return Ok(PortStatus {
            reachable: false,
            error: Some("Use a trusted local tunnel for remote Bitcoin Core ZMQ".to_string()),
        });
    }
    let timeout = Duration::from_secs(3);
    tauri::async_runtime::spawn_blocking(move || {
        let addr = match (host.as_str(), port).to_socket_addrs() {
            Ok(mut addrs) => match addrs.next() {
                Some(a) => a,
                None => {
                    return PortStatus {
                        reachable: false,
                        error: Some(format!("could not resolve {host}:{port}")),
                    }
                }
            },
            Err(e) => {
                return PortStatus {
                    reachable: false,
                    error: Some(e.to_string()),
                }
            }
        };
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(_) => PortStatus {
                reachable: true,
                error: None,
            },
            Err(e) => PortStatus {
                reachable: false,
                error: Some(e.to_string()),
            },
        }
    })
    .await
    .map_err(AppError::internal)
}

#[tauri::command]
pub fn get_version_info(app: tauri::AppHandle) -> VersionInfo {
    VersionInfo {
        app_version: app.package_info().version.to_string(),
        coinswap_source: format!("git {}", env!("PORTAL_COINSWAP_REV")),
    }
}

/// Ensures Tor is actually running (system → host binary → embedded fallback, see `crate::tor`)
/// before mirroring coinswap's own control-port handshake. Bootstrap < 100% is informational
/// only, not a failure.
#[tauri::command]
pub async fn check_tor(
    state: tauri::State<'_, AppState>,
    socks_port: u16,
    control_port: u16,
    tor_auth_password: String,
) -> Result<TorStatus, AppError> {
    validate_tor_control_secret(&tor_auth_password)?;
    let password = if tor_auth_password.is_empty() {
        state
            .tor_auth_secret
            .lock()?
            .as_ref()
            .map(|secret| secret.to_string())
            .unwrap_or_default()
    } else {
        *state.tor_auth_secret.lock()? = Some(zeroize::Zeroizing::new(tor_auth_password.clone()));
        tor_auth_password
    };
    let (status, child) = tauri::async_runtime::spawn_blocking(move || {
        let (source, child) = crate::tor::ensure_tor(socks_port, control_port);
        (
            run_tor_handshake(socks_port, control_port, &password, source),
            child,
        )
    })
    .await
    .map_err(AppError::internal)?;

    if let Some(child) = child {
        *state.managed_tor.lock()? = Some(child);
    }
    Ok(status)
}

fn run_tor_handshake(
    socks_port: u16,
    control_port: u16,
    password: &str,
    source: crate::tor::TorSource,
) -> TorStatus {
    let source_kind = source;
    let source = Some(source_kind.as_str().to_string());
    let unreachable = |err: String| TorStatus {
        reachable: false,
        authenticated: false,
        bootstrap_progress: None,
        error: Some(err),
        source: source.clone(),
    };

    if !crate::tor::socks5_responds(socks_port) {
        return unreachable("configured SOCKS port did not complete a SOCKS5 greeting".into());
    }

    let addr = match format!("127.0.0.1:{control_port}").to_socket_addrs() {
        Ok(mut addrs) => match addrs.next() {
            Some(a) => a,
            None => return unreachable("could not resolve control port address".into()),
        },
        Err(e) => return unreachable(e.to_string()),
    };

    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
        Ok(s) => s,
        Err(e) => return unreachable(e.to_string()),
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let mut reader = match stream.try_clone() {
        Ok(s) => BufReader::new(s),
        Err(e) => return unreachable(e.to_string()),
    };

    if stream.write_all(b"PROTOCOLINFO 1\r\n").is_err() {
        return unreachable("failed to send PROTOCOLINFO".into());
    }
    let mut protocol_lines = Vec::new();
    for _ in 0..32 {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.len() > 8192 {
            return unreachable("invalid Tor PROTOCOLINFO response".into());
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
        return unreachable("control port did not identify itself as Tor".into());
    }

    let auth_bytes = if matches!(
        source_kind,
        crate::tor::TorSource::HostBinary | crate::tor::TorSource::Embedded
    ) {
        match crate::tor::managed_cookie() {
            Ok(cookie) => cookie,
            Err(e) => return unreachable(format!("managed Tor cookie unavailable: {e}")),
        }
    } else {
        password.as_bytes().to_vec()
    };
    let command = if auth_bytes.is_empty() {
        "AUTHENTICATE\r\n".to_string()
    } else {
        let encoded = auth_bytes
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<String>();
        format!("AUTHENTICATE {encoded}\r\n")
    };
    if stream.write_all(command.as_bytes()).is_err() {
        return unreachable("failed to send AUTHENTICATE".into());
    }
    let mut resp = String::new();
    if reader.read_line(&mut resp).is_err() || !resp.starts_with("250") {
        return TorStatus {
            reachable: true,
            authenticated: false,
            bootstrap_progress: None,
            error: Some("Tor control-port authentication failed".into()),
            source,
        };
    }

    if stream
        .write_all(b"GETINFO status/bootstrap-phase\r\n")
        .is_err()
    {
        return TorStatus {
            reachable: true,
            authenticated: true,
            bootstrap_progress: None,
            error: None,
            source,
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
        authenticated: true,
        bootstrap_progress,
        error: None,
        source,
    }
}
