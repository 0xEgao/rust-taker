//! Which chain data source the wallet talks to: the bundled Electrum server or a
//! Bitcoin Core node the user added themselves.
//!
//! Persisted on the Rust side rather than in the frontend's localStorage because
//! four unrelated call sites need it — taker init, wallet restore, maker server
//! construction, and the connectivity probe — and only the first of those gets a
//! config object from the UI.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use coinswap::bitcoin::{Address, Network};
use coinswap::bitcoind::bitcoincore_rpc::bitcoincore_rpc_json::ListUnspentResultEntry;
use coinswap::bitcoind::bitcoincore_rpc::jsonrpc::{self, simple_http};
use coinswap::bitcoind::bitcoincore_rpc::{Auth, Client, RpcApi};
use coinswap::utill::get_taker_dir;
use coinswap::wallet::{BackendConfig, Blockchain, CoreRpcConfig, Electrum, ElectrumConfig};

use crate::error::{AppError, ErrorCode};
use crate::types::{
    BackendStatus, ChainBackendConfig, ChainBackendKind, ChainBackendView, ElectrumBackendDto,
    NodeBackendDto, NodeBackendViewDto,
};

/// Our signet Electrum server, used until the user points somewhere else.
const DEFAULT_ELECTRUM_URL: &str = "tcp://170.75.166.88:50001";

/// One bounded attempt is enough for a probe. The backend's own defaults (a 120s proxied
/// read timeout plus `max_retries` reconnects) would stall the UI for minutes before verdict.
const PROBE_TIMEOUT_SECS: u8 = 15;

const FILE_NAME: &str = "backend.json";

/// Serializes read-modify-write against the config file, same as `maker_settings`.
static BACKEND_IO: Mutex<()> = Mutex::new(());

/// Cached by complete endpoint/route fingerprint, never by process first-use.
static ELECTRUM_NETWORK: Mutex<Option<(String, Option<Network>)>> = Mutex::new(None);

impl Default for ChainBackendConfig {
    fn default() -> Self {
        Self {
            kind: ChainBackendKind::Electrum,
            electrum: ElectrumBackendDto {
                url: DEFAULT_ELECTRUM_URL.to_string(),
                use_tor: false,
            },
            node: None,
        }
    }
}

fn config_path() -> Result<PathBuf, AppError> {
    Ok(get_taker_dir()?.join(FILE_NAME))
}

/// Missing or unreadable file falls back to the defaults — a corrupt one must not
/// lock the user out of their wallet, and Settings rewrites it on the next save.
pub(crate) fn load() -> ChainBackendConfig {
    let Ok(path) = config_path() else {
        return ChainBackendConfig::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            log::warn!("could not parse {}: {e}; using defaults", path.display());
            ChainBackendConfig::default()
        }),
        Err(_) => ChainBackendConfig::default(),
    }
}

/// Written 0600 via a temp file + rename: it holds the node's RPC password, and a
/// half-written config would fall back to the bundled Electrum server on next start.
fn save(config: &ChainBackendConfig) -> Result<(), AppError> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        crate::security::fs::ensure_private_dir(parent)?;
    }
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp)?;
    let body = serde_json::to_string_pretty(config).map_err(AppError::internal)?;
    file.write_all(body.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// The crate cannot resolve an onion host without a proxy, so Tor is not optional there
/// regardless of what the user picked.
fn electrum_needs_tor(dto: &ElectrumBackendDto) -> bool {
    let host = dto
        .url
        .split_once("://")
        .map_or(dto.url.as_str(), |(_, rest)| rest);
    dto.use_tor
        || host
            .rsplit_once(':')
            .map_or(host, |(h, _)| h)
            .ends_with(".onion")
}

fn electrum_config(dto: &ElectrumBackendDto, socks_port: Option<u16>) -> ElectrumConfig {
    ElectrumConfig {
        url: dto.url.clone(),
        socks5: electrum_needs_tor(dto)
            .then(|| format!("127.0.0.1:{}", socks_port.unwrap_or(9050))),
        timeout: None,
        poll_interval_secs: None,
        max_retries: 3,
    }
}

fn core_rpc_config(dto: &NodeBackendDto, wallet_name: &str) -> CoreRpcConfig {
    CoreRpcConfig {
        url: format!("{}:{}", dto.host, dto.port),
        auth: Auth::UserPass(dto.username.clone(), dto.password.clone()),
        wallet_name: wallet_name.to_string(),
        zmq_addr: format!("tcp://{}:{}", dto.host, dto.zmq_port),
    }
}

/// Build the wallet backend the user selected. `wallet_name` names the watch-only
/// wallet on their node; Electrum has no server-side wallet so it ignores it.
pub(crate) fn resolve(
    wallet_name: &str,
    socks_port: Option<u16>,
) -> Result<BackendConfig, AppError> {
    let config = load();
    match config.kind {
        ChainBackendKind::Electrum => Ok(BackendConfig::Electrum(electrum_config(
            &config.electrum,
            socks_port,
        ))),
        ChainBackendKind::CoreRpc => {
            let node = config.node.ok_or_else(|| {
                AppError::new(
                    ErrorCode::InvalidInput,
                    "no Bitcoin node is configured — add one in Settings or switch back to Electrum",
                )
            })?;
            Ok(BackendConfig::CoreRpc(core_rpc_config(&node, wallet_name)))
        }
    }
}

fn validate(config: &ChainBackendConfig) -> Result<(), AppError> {
    let invalid = |msg: &str| AppError::new(ErrorCode::InvalidInput, msg.to_string());
    if config.electrum.url.chars().any(char::is_control) {
        return Err(invalid("Electrum URL contains control characters"));
    }
    let Some((scheme, authority)) = config.electrum.url.split_once("://") else {
        return Err(invalid(
            "Electrum URL must include a scheme, e.g. tcp://host:50001",
        ));
    };
    if !matches!(scheme, "tcp" | "ssl") || authority.is_empty() || !authority.contains(':') {
        return Err(invalid(
            "Electrum URL must use tcp:// or ssl:// with an explicit port",
        ));
    }
    if authority.contains('@') || authority.contains('#') {
        return Err(invalid(
            "Electrum URL cannot contain credentials or a fragment",
        ));
    }
    match &config.node {
        Some(node) => {
            if node.host.trim().is_empty() {
                return Err(invalid("node host cannot be empty"));
            }
            if node.port == 0 || node.zmq_port == 0 {
                return Err(invalid("node RPC and ZMQ ports must be set"));
            }
            if !matches!(node.host.as_str(), "127.0.0.1" | "localhost" | "::1") {
                return Err(invalid(
                    "Remote Bitcoin Core RPC/ZMQ is plaintext. Use a trusted tunnel and configure its local 127.0.0.1 or ::1 endpoint.",
                ));
            }
        }
        None if config.kind == ChainBackendKind::CoreRpc => {
            return Err(invalid("cannot select a node before one is added"));
        }
        None => {}
    }
    Ok(())
}

pub(crate) fn fingerprint(config: &ChainBackendConfig, socks_port: u16) -> String {
    match config.kind {
        ChainBackendKind::Electrum => format!(
            "electrum|{}|{}|{}",
            config.electrum.url,
            electrum_needs_tor(&config.electrum),
            socks_port
        ),
        ChainBackendKind::CoreRpc => config.node.as_ref().map_or_else(
            || "core|missing".to_string(),
            |node| format!("core|{}|{}|{}", node.host, node.port, node.zmq_port),
        ),
    }
}

/// Human-readable route disclosure without returning credentials to the renderer.
pub(crate) fn route_description(config: &ChainBackendConfig, socks_port: u16) -> String {
    match config.kind {
        ChainBackendKind::Electrum if electrum_needs_tor(&config.electrum) => format!(
            "Electrum {} through Tor SOCKS 127.0.0.1:{socks_port}",
            config.electrum.url
        ),
        ChainBackendKind::Electrum => {
            format!("Electrum {} directly (without Tor)", config.electrum.url)
        }
        ChainBackendKind::CoreRpc => config.node.as_ref().map_or_else(
            || "Bitcoin Core (configuration missing)".to_string(),
            |node| format!("Bitcoin Core RPC {}:{}", node.host, node.port),
        ),
    }
}

pub(crate) async fn preflight_active(state: &crate::state::AppState) -> Result<String, AppError> {
    let config = state
        .active_chain_backend
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)?;
    let socks_port = state.active_socks_port.read()?.unwrap_or(9050);
    let route_fingerprint = fingerprint(&config, socks_port);
    let status = tauri::async_runtime::spawn_blocking(move || match config.kind {
        ChainBackendKind::Electrum => probe_electrum(&config.electrum, Some(socks_port)),
        ChainBackendKind::CoreRpc => config
            .node
            .as_ref()
            .map(probe_core_rpc)
            .unwrap_or_else(|| unreachable("no Bitcoin node is configured".to_string())),
    })
    .await
    .map_err(AppError::internal)?;
    if !status.reachable {
        return Err(AppError::new(
            ErrorCode::RpcUnreachable,
            status
                .error
                .unwrap_or_else(|| "active chain backend preflight failed".to_string()),
        ));
    }
    Ok(route_fingerprint)
}

fn to_view(config: ChainBackendConfig) -> ChainBackendView {
    ChainBackendView {
        kind: config.kind,
        electrum: config.electrum,
        node: config.node.map(|node| NodeBackendViewDto {
            host: node.host,
            port: node.port,
            username: node.username,
            password_configured: !node.password.is_empty(),
            zmq_port: node.zmq_port,
        }),
    }
}

fn merge_preserved_password(mut config: ChainBackendConfig) -> ChainBackendConfig {
    if let Some(node) = config.node.as_mut() {
        if node.password.is_empty() {
            if let Some(saved) = load().node {
                if saved.host == node.host
                    && saved.port == node.port
                    && saved.username == node.username
                {
                    node.password = saved.password;
                }
            }
        }
    }
    config
}

#[tauri::command]
pub fn get_chain_backend() -> ChainBackendView {
    to_view(load())
}

#[tauri::command]
pub fn set_chain_backend(config: ChainBackendConfig) -> Result<(), AppError> {
    let config = merge_preserved_password(config);
    validate(&config)?;
    let _guard = BACKEND_IO.lock()?;
    save(&config)
}

/// Drops the saved config and hands back the defaults, so the bundled Electrum URL
/// stays defined in exactly one place instead of being mirrored in the UI.
#[tauri::command]
pub fn reset_chain_backend() -> Result<ChainBackendView, AppError> {
    let _guard = BACKEND_IO.lock()?;
    match std::fs::remove_file(config_path()?) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(to_view(ChainBackendConfig::default()))
}

/// Probe a backend. `config` overrides the saved one so Settings can test unsaved
/// edits; `None` probes whatever is currently active.
#[tauri::command]
pub async fn check_backend(
    config: Option<ChainBackendConfig>,
    socks_port: Option<u16>,
) -> Result<BackendStatus, AppError> {
    let config = config.map(merge_preserved_password).unwrap_or_else(load);
    tauri::async_runtime::spawn_blocking(move || match config.kind {
        ChainBackendKind::Electrum => probe_electrum(&config.electrum, socks_port),
        ChainBackendKind::CoreRpc => match &config.node {
            Some(node) => probe_core_rpc(node),
            None => unreachable("no Bitcoin node is configured".to_string()),
        },
    })
    .await
    .map_err(AppError::internal)
}

fn unreachable(error: String) -> BackendStatus {
    BackendStatus {
        reachable: false,
        error: Some(error),
        chain: None,
        blocks: None,
        synced: false,
        subversion: None,
        verification_progress: None,
    }
}

fn probe_electrum(dto: &ElectrumBackendDto, socks_port: Option<u16>) -> BackendStatus {
    let mut config = electrum_config(dto, socks_port);
    config.max_retries = 0;
    config.timeout = Some(PROBE_TIMEOUT_SECS);
    // Completes the Electrum handshake and checks the server's genesis hash, so this
    // rejects a reachable server on the wrong chain — a raw socket probe cannot.
    let client = match Electrum::new(&config) {
        Ok(c) => c,
        Err(e) => return unreachable(format!("{e:?}")),
    };
    match client.get_blockchain_info() {
        Ok(info) => BackendStatus {
            reachable: true,
            error: None,
            chain: Some(info.chain.to_string()),
            blocks: Some(info.blocks),
            synced: true,
            subversion: None,
            verification_progress: Some(1.0),
        },
        Err(e) => unreachable(format!("{e:?}")),
    }
}

fn probe_core_rpc(node: &NodeBackendDto) -> BackendStatus {
    let url = format!("http://{}:{}", node.host, node.port);
    // Built by hand rather than via `Client::new` so the probe inherits `PROBE_TIMEOUT_SECS`
    // instead of the transport's 15-minute default — this runs on the startup checklist,
    // where a filtered port would otherwise hang behind the OS connect timeout.
    let transport = match simple_http::Builder::new().url(&url).map(|b| {
        b.auth(node.username.clone(), Some(node.password.clone()))
            .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS as u64))
            .build()
    }) {
        Ok(t) => t,
        Err(e) => return unreachable(format!("{e:?}")),
    };
    let client = Client::from_jsonrpc(jsonrpc::Client::with_transport(transport));
    let info = match client.get_blockchain_info() {
        Ok(i) => i,
        Err(e) => {
            let msg = format!("{e:?}");
            let hint = if msg.contains("401") || msg.to_lowercase().contains("auth") {
                format!("authentication rejected by {url}")
            } else {
                msg
            };
            return unreachable(hint);
        }
    };
    BackendStatus {
        reachable: true,
        error: None,
        chain: Some(info.chain.to_string()),
        blocks: Some(info.blocks),
        synced: !info.initial_block_download && info.blocks == info.headers,
        subversion: client.get_network_info().ok().map(|n| n.subversion),
        verification_progress: Some(info.verification_progress),
    }
}

/// Address of a UTXO, re-derived from its scriptPubKey when the backend left it unset:
/// Electrum's `list_unspent` fills only the script (Core RPC fills the address), so the
/// wallet's UTXOs would otherwise have no address at all.
pub(crate) fn utxo_address(
    entry: &ListUnspentResultEntry,
    socks_port: Option<u16>,
) -> Option<String> {
    if let Some(address) = &entry.address {
        return Some(address.clone().assume_checked().to_string());
    }
    let network = electrum_network(socks_port)?;
    Address::from_script(&entry.script_pub_key, network)
        .ok()
        .map(|a| a.to_string())
}

/// `Wallet` keeps its network private, so it comes from the Electrum handshake. Probed once
/// per process — switching backend means restarting the app, and retrying on every UTXO
/// listing would stall the wallet page for the probe timeout while a server is unreachable.
fn electrum_network(socks_port: Option<u16>) -> Option<Network> {
    let config = load();
    if config.kind != ChainBackendKind::Electrum {
        return None;
    }
    let route = fingerprint(&config, socks_port.unwrap_or(9050));
    if let Ok(cache) = ELECTRUM_NETWORK.lock() {
        if let Some((cached_route, network)) = cache.as_ref() {
            if cached_route == &route {
                return *network;
            }
        }
    }
    let mut electrum = electrum_config(&config.electrum, socks_port);
    electrum.max_retries = 0;
    electrum.timeout = Some(PROBE_TIMEOUT_SECS);
    let network = match Electrum::new(&electrum).and_then(|c| c.get_blockchain_info()) {
        Ok(info) => Some(info.chain),
        Err(e) => {
            log::warn!("could not read network from Electrum; UTXO addresses stay blank: {e:?}");
            None
        }
    };
    if let Ok(mut cache) = ELECTRUM_NETWORK.lock() {
        *cache = Some((route, network));
    }
    network
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onion_url_forces_tor_even_when_unchecked() {
        let dto = ElectrumBackendDto {
            url: "tcp://abcdef.onion:50001".to_string(),
            use_tor: false,
        };
        assert!(electrum_config(&dto, Some(9050)).socks5.is_some());
    }

    #[test]
    fn clearnet_url_is_direct_by_default() {
        let dto = ElectrumBackendDto {
            url: DEFAULT_ELECTRUM_URL.to_string(),
            use_tor: false,
        };
        assert!(electrum_config(&dto, Some(9050)).socks5.is_none());
    }

    #[test]
    fn core_rpc_cannot_be_selected_without_a_node() {
        let config = ChainBackendConfig {
            kind: ChainBackendKind::CoreRpc,
            node: None,
            ..Default::default()
        };
        assert!(validate(&config).is_err());
    }
}
