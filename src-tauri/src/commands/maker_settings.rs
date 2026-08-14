//! Persistent maker registrations. Runtime objects are deliberately absent:
//! makers are reconstructed from these settings and their wallet files only
//! when `start_maker` is explicitly called.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use coinswap::utill::get_maker_dir;

use crate::error::{AppError, ErrorCode};
use crate::state::AppState;
use crate::types::{MakerPortCheckDto, MakerSettingsDto, SuggestedMakerPortsDto};

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredMakers {
    #[serde(default)]
    makers: HashMap<String, MakerSettingsDto>,
    /// Distinguishes "the Maker Dashboard import has never run" from "it has run,
    /// or the user has curated this registry". Without it, an empty `makers` map
    /// reads as a pending migration, so removing the last maker re-runs the
    /// import and resurrects every registration the user just deleted.
    #[serde(default)]
    dashboard_migrated: bool,
    /// Ids removed through the UI. Removing a maker there is the permanent gesture — its
    /// wallet and data dir are left alone — so these must never be listed or re-imported
    /// again, however the registry got emptied in the meantime.
    #[serde(default)]
    deleted: HashSet<String>,
}

/// Compatibility shape for Maker Dashboard's registration store. Credentials
/// and backend fields are intentionally not represented, so they can never be
/// copied into this app's unencrypted registry.
#[derive(Debug, Default, serde::Deserialize)]
struct DashboardStoredMakers {
    #[serde(default)]
    makers: HashMap<String, DashboardMakerSettings>,
}

#[derive(Debug, serde::Deserialize)]
struct DashboardMakerSettings {
    data_directory: Option<String>,
    wallet_name: Option<String>,
    #[serde(default = "default_network_port")]
    network_port: u16,
    #[serde(default = "default_rpc_port")]
    rpc_port: u16,
    #[serde(default = "default_socks_port")]
    socks_port: u16,
    #[serde(default = "default_control_port")]
    control_port: u16,
    #[serde(default = "default_min_swap_amount")]
    min_swap_amount: u64,
    #[serde(default = "default_fidelity_amount")]
    fidelity_amount: u64,
    #[serde(default = "default_fidelity_timelock")]
    fidelity_timelock: u32,
    #[serde(default = "default_required_confirms")]
    required_confirms: u32,
    #[serde(default = "default_base_fee")]
    base_fee: u64,
    #[serde(default = "default_amount_relative_fee_pct")]
    amount_relative_fee_pct: f64,
    #[serde(default = "default_time_relative_fee_pct")]
    time_relative_fee_pct: f64,
}

fn default_network_port() -> u16 {
    6102
}
fn default_rpc_port() -> u16 {
    6103
}
fn default_socks_port() -> u16 {
    9050
}
fn default_control_port() -> u16 {
    9051
}
fn default_min_swap_amount() -> u64 {
    10_000
}
fn default_fidelity_amount() -> u64 {
    10_000
}
fn default_fidelity_timelock() -> u32 {
    15_000
}
fn default_required_confirms() -> u32 {
    1
}
fn default_base_fee() -> u64 {
    1_000
}
fn default_amount_relative_fee_pct() -> f64 {
    0.025
}
fn default_time_relative_fee_pct() -> f64 {
    0.001
}

static SETTINGS_IO: Mutex<()> = Mutex::new(());

fn settings_path() -> Result<PathBuf, AppError> {
    Ok(get_maker_dir()?.join("makers.json"))
}

fn dashboard_settings_path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("maker-dashboard").join("makers.json"))
}

fn load_file(path: &Path) -> Result<StoredMakers, AppError> {
    if !path.exists() {
        return Ok(StoredMakers::default());
    }
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| AppError::internal(format!("failed to parse {}: {e}", path.display())))
}

fn save_file(path: &Path, stored: &StoredMakers) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_vec_pretty(stored).map_err(AppError::internal)?;
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(&payload)?;
    file.sync_all()?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn load_dashboard_registrations(
    path: &Path,
) -> Result<HashMap<String, MakerSettingsDto>, AppError> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = std::fs::read(path)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::internal(format!("failed to parse {}: {e}", path.display())))?;
    // Password-encrypted dashboard stores require an explicit migration flow;
    // silently treating their envelope as maker settings would lose config.
    if value.get("v").is_some() && value.get("data").is_some() {
        return Ok(HashMap::new());
    }
    let stored: DashboardStoredMakers = serde_json::from_value(value)
        .map_err(|e| AppError::internal(format!("failed to parse {}: {e}", path.display())))?;
    Ok(stored
        .makers
        .into_iter()
        .map(|(maker_id, settings)| {
            let wallet_name = settings.wallet_name.unwrap_or_else(|| maker_id.clone());
            let dto = MakerSettingsDto {
                maker_id: maker_id.clone(),
                wallet_name,
                network_port: settings.network_port,
                rpc_port: settings.rpc_port,
                socks_port: settings.socks_port,
                control_port: settings.control_port,
                tor_auth_password: None,
                min_swap_amount: settings.min_swap_amount,
                fidelity_amount: settings.fidelity_amount,
                fidelity_timelock: settings.fidelity_timelock,
                required_confirms: settings.required_confirms,
                base_fee: settings.base_fee,
                amount_relative_fee_pct: settings.amount_relative_fee_pct,
                time_relative_fee_pct: settings.time_relative_fee_pct,
                data_dir: settings.data_directory,
            };
            (maker_id, dto)
        })
        .collect())
}

pub(crate) fn load_all() -> Result<HashMap<String, MakerSettingsDto>, AppError> {
    let _guard = SETTINGS_IO.lock()?;
    let path = settings_path()?;
    let mut stored = load_file(&path)?;
    // An empty registry that has already been imported from is a user decision,
    // not a pending migration. Registries predating `dashboard_migrated` default
    // it to false, so a populated one must still suppress the import.
    if stored.makers.is_empty() && !stored.dashboard_migrated {
        if let Some(dashboard_path) = dashboard_settings_path() {
            let mut discovered = load_dashboard_registrations(&dashboard_path)?;
            discovered.retain(|maker_id, _| !stored.deleted.contains(maker_id));
            // Leave the flag clear when nothing was found, so a dashboard
            // installed or decrypted later still migrates.
            if !discovered.is_empty() {
                stored.makers = discovered;
                stored.dashboard_migrated = true;
                save_file(&path, &stored)?;
            }
        }
    }
    Ok(stored.makers)
}

pub(crate) fn load(maker_id: &str) -> Result<Option<MakerSettingsDto>, AppError> {
    Ok(load_all()?.remove(maker_id))
}

pub(crate) fn save(settings: &MakerSettingsDto) -> Result<(), AppError> {
    let _guard = SETTINGS_IO.lock()?;
    let path = settings_path()?;
    let mut stored = load_file(&path)?;
    // Re-adding an id under the same name is a deliberate revival, so it stops being deleted.
    stored.deleted.remove(&settings.maker_id);
    stored
        .makers
        .insert(settings.maker_id.clone(), settings.clone());
    save_file(&path, &stored)
}

#[tauri::command]
pub fn list_makers() -> Result<Vec<MakerSettingsDto>, AppError> {
    let mut makers: Vec<_> = load_all()?.into_values().collect();
    makers.sort_by(|a, b| a.maker_id.cmp(&b.maker_id));
    Ok(makers)
}

#[tauri::command]
pub fn get_saved_maker_settings(maker_id: String) -> Result<Option<MakerSettingsDto>, AppError> {
    load(&maker_id)
}

#[tauri::command]
pub fn clear_maker_settings(
    state: tauri::State<'_, AppState>,
    maker_id: String,
) -> Result<(), AppError> {
    if let Some(entry) = state.makers.lock()?.get(&maker_id) {
        if !matches!(
            entry.phase,
            crate::types::MakerPhase::Stopped | crate::types::MakerPhase::Failed { .. }
        ) {
            return Err(AppError::maker_busy());
        }
    }
    let _guard = SETTINGS_IO.lock()?;
    let path = settings_path()?;
    let mut stored = load_file(&path)?;
    stored.makers.remove(&maker_id);
    stored.deleted.insert(maker_id.clone());
    // An explicit delete settles the migration even for a registry that was
    // populated natively, so emptying it can never re-run the dashboard import.
    stored.dashboard_migrated = true;
    save_file(&path, &stored)?;
    state.makers.lock()?.remove(&maker_id);
    crate::logging::unregister_maker(&maker_id);
    Ok(())
}

fn is_port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn find_available_port(start: u16, reserved: &[u16]) -> Option<u16> {
    (start..=u16::MAX).find(|port| !reserved.contains(port) && is_port_free(*port))
}

#[tauri::command]
pub fn get_suggested_maker_ports(
    socks_port: u16,
    control_port: u16,
) -> Result<SuggestedMakerPortsDto, AppError> {
    const DEFAULT_NETWORK_PORT: u16 = 6102;
    const DEFAULT_RPC_PORT: u16 = 6103;

    let registered = load_all()?;
    let mut reserved = vec![socks_port, control_port];
    reserved.extend(
        registered
            .values()
            .flat_map(|m| [m.network_port, m.rpc_port]),
    );

    let network_port = find_available_port(DEFAULT_NETWORK_PORT, &reserved)
        .ok_or_else(|| AppError::new(ErrorCode::Internal, "no available network port found"))?;
    reserved.push(network_port);
    let rpc_port = find_available_port(DEFAULT_RPC_PORT, &reserved)
        .ok_or_else(|| AppError::new(ErrorCode::Internal, "no available rpc port found"))?;

    Ok(SuggestedMakerPortsDto {
        network_port,
        rpc_port,
    })
}

/// Why `port` cannot be a maker listener, or `None` if it can.
///
/// Deliberately not `setup::check_port`: that connects and reports success when something
/// is *already listening*, the inverse of what a port we intend to bind needs — wiring it
/// in here would approve exactly the ports that are taken.
fn port_conflict(port: u16, socks_port: u16, control_port: u16, taken: &HashMap<u16, String>) -> Option<String> {
    if port == 0 {
        return Some("Not a valid port.".to_string());
    }
    if port == socks_port || port == control_port {
        return Some(format!("Port {port} is already used by Tor."));
    }
    if let Some(owner) = taken.get(&port) {
        return Some(format!("Port {port} is already used by maker '{owner}'."));
    }
    if !is_port_free(port) {
        return Some(format!("Port {port} is already in use. Pick another."));
    }
    None
}

/// Validates a maker's two listener ports so the UI can warn before `init_maker` writes a
/// wallet — a failure there has to be unwound (`maker::abort_failed_creation`).
#[tauri::command]
pub fn check_maker_ports(
    network_port: u16,
    rpc_port: u16,
    socks_port: u16,
    control_port: u16,
) -> Result<MakerPortCheckDto, AppError> {
    let mut taken = HashMap::new();
    for (id, settings) in load_all()? {
        taken.insert(settings.network_port, id.clone());
        taken.insert(settings.rpc_port, id);
    }

    let mut result = MakerPortCheckDto {
        network_port: port_conflict(network_port, socks_port, control_port, &taken),
        rpc_port: port_conflict(rpc_port, socks_port, control_port, &taken),
    };
    // Both bind the same host, so an identical pair fails at start even though each port is
    // free on its own.
    if result.rpc_port.is_none() && network_port == rpc_port {
        result.rpc_port = Some("Network and RPC ports must differ.".to_string());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> MakerSettingsDto {
        MakerSettingsDto {
            maker_id: "maker-one".to_string(),
            wallet_name: "wallet-one".to_string(),
            network_port: 6102,
            rpc_port: 6103,
            socks_port: 9050,
            control_port: 9051,
            tor_auth_password: Some("secret".to_string()),
            min_swap_amount: 10_000,
            fidelity_amount: 10_000,
            fidelity_timelock: 15_000,
            required_confirms: 1,
            base_fee: 500,
            amount_relative_fee_pct: 0.0025,
            time_relative_fee_pct: 0.0001,
            data_dir: Some("/tmp/maker-one".to_string()),
        }
    }

    #[test]
    fn stored_makers_default_when_makers_field_is_missing() {
        let decoded: StoredMakers = serde_json::from_str("{}").unwrap();
        assert!(decoded.makers.is_empty());
        assert!(!decoded.dashboard_migrated);
    }

    /// An emptied registry must not read as a pending dashboard migration, or removing the
    /// last imported maker silently resurrects every registration on the next `load_all`.
    #[test]
    fn emptied_registry_is_distinguishable_from_an_unmigrated_one() {
        let unmigrated: StoredMakers = serde_json::from_str(r#"{"makers":{}}"#).unwrap();
        assert!(unmigrated.makers.is_empty() && !unmigrated.dashboard_migrated);

        let mut emptied = StoredMakers {
            makers: HashMap::from([("maker-one".to_string(), settings())]),
            dashboard_migrated: true,
            deleted: HashSet::new(),
        };
        emptied.makers.remove("maker-one");
        let round_tripped: StoredMakers =
            serde_json::from_slice(&serde_json::to_vec(&emptied).unwrap()).unwrap();
        assert!(round_tripped.makers.is_empty());
        assert!(round_tripped.dashboard_migrated);
    }

    /// Removing a maker in the UI is the permanent gesture. Its tombstone has to survive the
    /// round trip through `makers.json` and keep the dashboard import from bringing the id
    /// back, which is how three deleted makers previously reappeared.
    #[test]
    fn removal_tombstone_persists_and_blocks_reimport() {
        let mut stored = StoredMakers {
            makers: HashMap::from([("Zoro".to_string(), settings())]),
            dashboard_migrated: true,
            deleted: HashSet::new(),
        };
        stored.makers.remove("Zoro");
        stored.deleted.insert("Zoro".to_string());

        let reloaded: StoredMakers =
            serde_json::from_slice(&serde_json::to_vec(&stored).unwrap()).unwrap();
        assert!(reloaded.deleted.contains("Zoro"));

        let mut discovered = HashMap::from([
            ("Zoro".to_string(), settings()),
            ("Luffy".to_string(), settings()),
        ]);
        discovered.retain(|maker_id, _| !reloaded.deleted.contains(maker_id));
        assert_eq!(discovered.into_keys().collect::<Vec<_>>(), vec!["Luffy"]);
    }

    #[test]
    fn persisted_registration_omits_tor_password() {
        let mut makers = HashMap::new();
        makers.insert("maker-one".to_string(), settings());
        let value = serde_json::to_value(StoredMakers {
            makers,
            dashboard_migrated: true,
            deleted: HashSet::new(),
        })
        .unwrap();
        assert!(value["makers"]["maker-one"]
            .get("torAuthPassword")
            .is_none());
    }

    #[test]
    fn port_conflict_names_tor_and_other_makers() {
        let mut taken = HashMap::new();
        taken.insert(6102, "maker-one".to_string());

        assert!(port_conflict(9050, 9050, 9051, &taken)
            .expect("socks port must conflict")
            .contains("Tor"));
        assert!(port_conflict(9051, 9050, 9051, &taken)
            .expect("control port must conflict")
            .contains("Tor"));
        assert!(port_conflict(6102, 9050, 9051, &taken)
            .expect("registered maker port must conflict")
            .contains("maker-one"));
        assert!(port_conflict(0, 9050, 9051, &taken).is_some());
    }

    #[test]
    fn port_conflict_reports_an_occupied_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        // Held open for the duration of the check, so the bind probe must fail.
        assert!(port_conflict(port, 9050, 9051, &HashMap::new()).is_some());
        drop(listener);
        assert!(port_conflict(port, 9050, 9051, &HashMap::new()).is_none());
    }

    #[test]
    fn identical_network_and_rpc_ports_are_rejected() {
        let free = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        let result = check_maker_ports(port, port, 9050, 9051).unwrap();
        assert!(result.network_port.is_none());
        assert!(result.rpc_port.expect("duplicate must be caught").contains("differ"));
    }

    #[test]
    fn imports_plaintext_dashboard_registrations_without_credentials() {
        let value = serde_json::json!({
            "makers": {
                "Zoro": {
                    "data_directory": "/tmp/Zoro",
                    "wallet_name": "Zoro",
                    "password": "wallet-secret",
                    "rpc_password": "rpc-secret",
                    "tor_auth": "tor-secret",
                    "network_port": 6104,
                    "rpc_port": 6105,
                    "socks_port": 9050,
                    "control_port": 9051,
                    "min_swap_amount": 20_000,
                    "fidelity_amount": 30_000,
                    "fidelity_timelock": 15_000,
                    "required_confirms": 2,
                    "base_fee": 900,
                    "amount_relative_fee_pct": 0.02,
                    "time_relative_fee_pct": 0.001
                }
            }
        });
        let path = std::env::temp_dir().join(format!(
            "rust-taker-dashboard-import-{}.json",
            std::process::id()
        ));
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let makers = load_dashboard_registrations(&path).unwrap();
        let _ = std::fs::remove_file(path);

        let zoro = makers.get("Zoro").unwrap();
        assert_eq!(zoro.wallet_name, "Zoro");
        assert_eq!(zoro.network_port, 6104);
        assert_eq!(zoro.min_swap_amount, 20_000);
        assert!(zoro.tor_auth_password.is_none());
    }

    #[test]
    fn ignores_encrypted_dashboard_store_until_explicit_migration() {
        let path = std::env::temp_dir().join(format!(
            "rust-taker-dashboard-encrypted-{}.json",
            std::process::id()
        ));
        std::fs::write(&path, br#"{"v":1,"data":"encrypted"}"#).unwrap();
        let makers = load_dashboard_registrations(&path).unwrap();
        let _ = std::fs::remove_file(path);
        assert!(makers.is_empty());
    }
}
