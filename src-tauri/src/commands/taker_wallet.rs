//! Wallet lifecycle: init, shutdown, encryption probe, restore, backup.
//!
//! Wallet load/restore commands must route errors through
//! `from_wallet_join_error`, not `AppError::internal` — a wrong password
//! panics inside the crate instead of returning `Result`.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime};

use coinswap::bitcoin::{Address, OutPoint, Txid};
use coinswap::fee_estimation::FeeEstimator;
use coinswap::nostr_coinswap::NOSTR_RELAYS;
use coinswap::taker::api::ConnectionType;
use coinswap::taker::{Taker, TakerInitConfig};
use coinswap::utill::get_taker_dir;
use coinswap::wallet::{AddressType, Wallet};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use uuid::Uuid;

use crate::commands::chain_backend;
use crate::error::{from_wallet_join_error, AppError, ErrorCode};
use crate::security::input::{validate_leaf_name, validate_password, validate_tor_control_secret};
use crate::security::operation::{ensure_main_window, SensitiveOperation, SensitiveOperationGuard};
use crate::state::AppState;
use crate::state::PendingFileSelection;
use crate::types::{
    AddressTypeDto, AddressValidation, BalancesDto, ConnectionTypeDto, FeeEstimate, InitConfig,
    InitResult, NewAddress, Outpoint, PriceEstimate, RestoreSelectionView, SendResult,
    SwapLiquidity, TxSummary, UtxoEntry, WalletInfo,
};

const BTC_PRICE_CACHE_FILE: &str = "btc-price-cache.json";
const MAX_PRICE_CACHE_BYTES: u64 = 4096;
static PRICE_CACHE_IO: Mutex<()> = Mutex::new(());

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedBtcPrice {
    usd: f64,
    fetched_at: u64,
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn valid_usd_price(usd: f64) -> bool {
    usd.is_finite() && usd > 0.0
}

fn price_cache_path() -> Result<PathBuf, AppError> {
    Ok(get_taker_dir()?.join(BTC_PRICE_CACHE_FILE))
}

fn load_cached_btc_price() -> Result<Option<CachedBtcPrice>, AppError> {
    let _guard = PRICE_CACHE_IO.lock()?;
    let path = price_cache_path()?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_PRICE_CACHE_BYTES
    {
        return Ok(None);
    }
    let cached: CachedBtcPrice =
        serde_json::from_slice(&std::fs::read(path)?).map_err(AppError::internal)?;
    if !valid_usd_price(cached.usd) {
        return Ok(None);
    }
    Ok(Some(cached))
}

fn save_cached_btc_price(cached: &CachedBtcPrice) -> Result<(), AppError> {
    let _guard = PRICE_CACHE_IO.lock()?;
    let path = price_cache_path()?;
    if let Some(parent) = path.parent() {
        crate::security::fs::ensure_private_dir(parent)?;
    }
    let body = serde_json::to_vec(cached).map_err(AppError::internal)?;
    crate::security::fs::write_private(&path, &body)
}

fn resolve_data_dir(data_dir: &Option<String>) -> Result<PathBuf, AppError> {
    match data_dir {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => Ok(get_taker_dir()?),
    }
}

/// `pub(crate)` so `commands::maker` can build the maker's own wallet path the same way.
pub(crate) fn wallet_path(data_dir: &std::path::Path, wallet_name: &str) -> PathBuf {
    data_dir.join("wallets").join(wallet_name)
}

/// Cloning the Arc (not the Wallet) keeps this independent of the taker mutex.
pub(crate) fn get_wallet_handle(state: &AppState) -> Result<Arc<RwLock<Wallet>>, AppError> {
    state
        .wallet
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)
}

/// Probes the on-disk format only — never decrypts, no password needed.
#[tauri::command]
pub async fn is_wallet_encrypted(
    data_dir: Option<String>,
    wallet_name: String,
) -> Result<bool, AppError> {
    validate_leaf_name(&wallet_name, "walletName")?;
    let path = wallet_path(&resolve_data_dir(&data_dir)?, &wallet_name);
    tauri::async_runtime::spawn_blocking(move || Wallet::is_wallet_encrypted(&path))
        .await
        .map_err(AppError::internal)?
        .map_err(AppError::from)
}

/// Non-wallet files written into the same directory (crate's report/lock/temp, plus our own
/// last-issued-address sidecar).
const NON_WALLET_SUFFIXES: &[&str] = &[
    "_swap_report.json",
    "_last_address.json",
    ".lock",
    ".partial",
    ".tmp",
];

#[tauri::command]
pub fn list_wallets(data_dir: Option<String>) -> Result<Vec<String>, AppError> {
    let dir = resolve_data_dir(&data_dir)?.join("wallets");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            if let Some(name) = entry.file_name().to_str() {
                if !NON_WALLET_SUFFIXES.iter().any(|suf| name.ends_with(suf)) {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

/// Creates or loads the wallet, connects to Bitcoin Core, checks Tor,
/// starts background threads. Blocking; can take a few seconds.
#[tauri::command]
pub async fn init_taker(
    state: tauri::State<'_, AppState>,
    mut config: InitConfig,
) -> Result<InitResult, AppError> {
    validate_leaf_name(&config.wallet_name, "walletName")?;
    if let Some(password) = config.tor_auth_password.as_deref() {
        validate_tor_control_secret(password)?;
        if !password.is_empty() {
            *state.tor_auth_secret.lock()? = Some(zeroize::Zeroizing::new(password.to_string()));
        }
    }
    if config
        .tor_auth_password
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        config.tor_auth_password = state
            .tor_auth_secret
            .lock()?
            .as_ref()
            .map(|secret| secret.to_string());
    }
    {
        let guard = crate::state::try_lock_taker(&state.taker)?;
        if guard.is_some() {
            return Err(AppError::new(
                ErrorCode::Internal,
                "taker is already initialized for this session",
            ));
        }
    }

    let data_dir = resolve_data_dir(&config.data_dir)?;
    if config.data_dir.is_some() {
        crate::security::fs::require_private_dir(&data_dir)?;
    } else {
        crate::security::fs::ensure_private_dir(&data_dir)?;
    }
    crate::security::fs::ensure_private_dir(&data_dir.join("wallets"))?;
    let connection_type = match config.connection_type {
        ConnectionTypeDto::Tor => ConnectionType::Tor,
        ConnectionTypeDto::Clearnet => ConnectionType::Clearnet,
    };

    let init_cfg = TakerInitConfig {
        data_dir: Some(data_dir.clone()),
        wallet_name: config.wallet_name.clone(),
        backend: chain_backend::resolve(&config.wallet_name, config.socks_port)?,
        control_port: config.control_port,
        tor_auth_password: config.tor_auth_password,
        socks_port: config.socks_port.unwrap_or(9050),
        password: config.wallet_password,
        connection_type,
        nostr_relays: NOSTR_RELAYS.iter().map(|s| s.to_string()).collect(),
    };
    let wallet_name = config.wallet_name;

    // Our own dual-role logger, not the crate's setup_taker_logger — see logging.rs.
    crate::logging::set_taker_dir(data_dir.clone());

    let taker = tauri::async_runtime::spawn_blocking(move || Taker::init(init_cfg))
        .await
        .map_err(from_wallet_join_error)?
        .map_err(AppError::from)?;

    let recovery_pending = taker
        .get_wallet()
        .read()
        .map(|w| !w.list_live_contract_spend_info().is_empty())
        .unwrap_or(false);

    // A previous `shutdown` latched this; re-arm so syncs on the new taker aren't
    // cancelled the moment they start.
    state.sync_cancel.store(false, Ordering::Relaxed);
    *state.wallet.write()? = Some(taker.get_wallet().clone());
    *state.offer_sync.write()? = Some(taker.offer_sync_client());
    *state.data_dir.write()? = Some(data_dir.clone());
    *state.active_chain_backend.write()? = Some(chain_backend::load());
    *state.active_socks_port.write()? = Some(config.socks_port.unwrap_or(9050));
    *state.taker.lock()? = Some(taker);

    Ok(InitResult {
        wallet_name,
        data_dir: data_dir.display().to_string(),
        recovery_pending,
    })
}

/// Drops the Taker and reports success only when its decrypted handles were
/// actually removed. Process-close callers may ignore an in-progress error,
/// but interactive lock/reset must not reset its UI on that error.
pub fn shutdown(state: &AppState) -> Result<(), AppError> {
    if state.active_swap.lock()?.as_ref().is_some_and(|swap| {
        matches!(
            swap.phase,
            crate::state::SwapLifecycle::Running | crate::state::SwapLifecycle::Recovering
        )
    }) {
        return Err(AppError::swap_in_progress());
    }
    // Released before the handles below, so a sync already inside the crate's retry loop
    // unwinds instead of holding a blocking thread against a backend that is going away.
    state.sync_cancel.store(true, Ordering::Relaxed);
    let mut taker = crate::state::try_lock_taker(&state.taker)?;
    taker.take();
    drop(taker);
    *state.wallet.write()? = None;
    *state.offer_sync.write()? = None;
    *state.data_dir.write()? = None;
    *state.active_chain_backend.write()? = None;
    *state.active_socks_port.write()? = None;
    *state.tor_auth_secret.lock()? = None;
    state.pending_file_selections.lock()?.clear();
    *state.active_swap.lock()? = None;
    Ok(())
}

#[tauri::command]
pub fn shutdown_taker(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    shutdown(&state)
}

#[tauri::command]
pub fn get_wallet_info(state: tauri::State<'_, AppState>) -> Result<WalletInfo, AppError> {
    let wallet_name = get_wallet_handle(&state)?.read()?.get_name().to_string();
    let data_dir = state
        .data_dir
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)?;
    Ok(WalletInfo {
        wallet_path: wallet_path(&data_dir, &wallet_name).display().to_string(),
        wallet_name,
        data_dir: data_dir.display().to_string(),
    })
}

/// Opens a native picker and retains the selected local path only in Rust.
#[tauri::command]
pub async fn choose_restore_backup(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<RestoreSelectionView, AppError> {
    ensure_main_window(&window)?;
    let _operation = SensitiveOperationGuard::acquire(
        &state.sensitive_operation_active,
        SensitiveOperation::RestorePrivateKey,
    )?;
    let dialog_window = window.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_window
            .dialog()
            .file()
            .add_filter("Portal wallet backup", &["json"])
            .blocking_pick_file()
    })
    .await
    .map_err(AppError::internal)?
    .ok_or_else(|| AppError::user_cancelled("restore file selection was cancelled"))?;
    let path = selected.into_path().map_err(|_| {
        AppError::new(
            ErrorCode::InvalidFileSelection,
            "restore selection is not a local filesystem path",
        )
    })?;
    let metadata = std::fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::new(
            ErrorCode::InvalidFileSelection,
            "restore selection must be a regular file, not a symlink",
        ));
    }
    let canonical = std::fs::canonicalize(path)?;
    let display_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("wallet backup")
        .to_string();
    let selection_id = Uuid::new_v4();
    let mut selections = state.pending_file_selections.lock()?;
    selections.retain(|_, item| item.created_at.elapsed() <= Duration::from_secs(300));
    selections.insert(
        selection_id,
        PendingFileSelection {
            path: canonical,
            created_at: std::time::Instant::now(),
        },
    );
    Ok(RestoreSelectionView {
        selection_id,
        display_name,
    })
}

/// Restore from a Rust-selected backup before `init_taker`. Bad password/file panics (caught via
/// from_wallet_join_error); a real WalletError is swallowed by the crate, so check the output.
#[tauri::command]
pub async fn restore_wallet(
    state: tauri::State<'_, AppState>,
    data_dir: Option<String>,
    wallet_name: String,
    socks_port: Option<u16>,
    selection_id: Uuid,
    password: Option<String>,
) -> Result<(), AppError> {
    validate_leaf_name(&wallet_name, "walletName")?;
    let _operation = SensitiveOperationGuard::acquire(
        &state.sensitive_operation_active,
        SensitiveOperation::RestorePrivateKey,
    )?;
    let selection = state
        .pending_file_selections
        .lock()?
        .remove(&selection_id)
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::InvalidFileSelection,
                "restore file selection is missing, expired, or already used",
            )
        })?;
    if selection.created_at.elapsed() > Duration::from_secs(300) {
        return Err(AppError::new(
            ErrorCode::InvalidFileSelection,
            "restore file selection expired; choose the file again",
        ));
    }
    let dir = resolve_data_dir(&data_dir)?;
    if data_dir.is_some() {
        crate::security::fs::require_private_dir(&dir)?;
    } else {
        crate::security::fs::ensure_private_dir(&dir)?;
    }
    crate::security::fs::ensure_private_dir(&dir.join("wallets"))?;
    let restored_path = wallet_path(&dir, &wallet_name);
    let backend = chain_backend::resolve(&wallet_name, socks_port)?;
    let backup_path = selection.path;

    // `Wallet::restore` refuses to overwrite an existing file and only logs the
    // refusal, which would leave the post-restore `exists()` check below passing
    // on the *old* wallet and reporting a restore that never happened.
    if restored_path.exists() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            format!("a wallet named '{wallet_name}' already exists — pick another name"),
        ));
    }

    tauri::async_runtime::spawn_blocking(move || {
        coinswap::wallet::ffi::restore_wallet_gui_app(
            Some(dir),
            Some(wallet_name),
            backend,
            backup_path,
            password,
        )
    })
    .await
    .map_err(from_wallet_join_error)?;

    if !restored_path.exists() {
        return Err(AppError::new(
            ErrorCode::WalletLoadFailed,
            "restore did not produce a wallet file — check the app log for the underlying cause",
        ));
    }
    Ok(())
}

/// Backs up to encrypted JSON (xpriv, not a seed phrase). Rust owns the save dialog.
#[tauri::command]
pub async fn backup_wallet(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    password: String,
) -> Result<String, AppError> {
    ensure_main_window(&window)?;
    validate_password(&password, "backup password")?;
    let _operation = SensitiveOperationGuard::acquire(
        &state.sensitive_operation_active,
        SensitiveOperation::BackupPrivateKey,
    )?;
    let wallet = get_wallet_handle(&state)?;
    let date = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let dialog_window = window.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_window
            .dialog()
            .file()
            .set_file_name(format!("portal-wallet-backup-{date}.json"))
            .add_filter("JSON files", &["json"])
            .blocking_save_file()
    })
    .await
    .map_err(AppError::internal)?
    .ok_or_else(|| AppError::user_cancelled("backup destination selection was cancelled"))?;
    let destination = selected.into_path().map_err(|_| {
        AppError::new(
            ErrorCode::InvalidFileSelection,
            "backup destination is not a local filesystem path",
        )
    })?;
    if destination.exists()
        && std::fs::symlink_metadata(&destination)?
            .file_type()
            .is_symlink()
    {
        return Err(AppError::new(
            ErrorCode::InvalidFileSelection,
            "backup destination cannot be a symlink",
        ));
    }
    let destination_path = destination.display().to_string();
    let display_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("wallet backup")
        .to_string();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        wallet
            .read()?
            .backup_wallet_gui_app(destination_path, Some(password))?;
        Ok(())
    })
    .await
    .map_err(AppError::internal)??;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(display_name)
}

// --- Wallet operations: balances, addresses, history, UTXOs, send, sync, fees ---

/// Validate address encoding before review without coupling the UI to a
/// particular Bitcoin network. send_to_address performs the authoritative
/// active-wallet network check before constructing a transaction.
#[tauri::command]
pub fn validate_address(address: String) -> AddressValidation {
    let address = address.trim();
    if address.is_empty() {
        return AddressValidation {
            valid: false,
            error: Some("Enter a recipient address.".to_string()),
        };
    }

    match Address::from_str(address) {
        Ok(_) => AddressValidation {
            valid: true,
            error: None,
        },
        Err(_) => AddressValidation {
            valid: false,
            error: Some("Enter a valid Bitcoin address.".to_string()),
        },
    }
}

#[tauri::command]
pub async fn get_balances(state: tauri::State<'_, AppState>) -> Result<BalancesDto, AppError> {
    let wallet = get_wallet_handle(&state)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<BalancesDto, AppError> {
        let b = wallet.read()?.get_balances()?;
        Ok(BalancesDto {
            regular: b.regular.to_sat(),
            swap: b.swap.to_sat(),
            contract: b.contract.to_sat(),
            fidelity: b.fidelity.to_sat(),
            spendable: b.spendable.to_sat(),
        })
    })
    .await
    .map_err(AppError::internal)?
}

/// max_swappable = max(regular, swap) − 3000 sats dust buffer.
#[tauri::command]
pub async fn check_swap_liquidity(
    state: tauri::State<'_, AppState>,
) -> Result<SwapLiquidity, AppError> {
    let wallet = get_wallet_handle(&state)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<SwapLiquidity, AppError> {
        let b = wallet.read()?.get_balances()?;
        let regular = b.regular.to_sat();
        let swap = b.swap.to_sat();
        Ok(SwapLiquidity {
            spendable: b.spendable.to_sat(),
            regular,
            swap,
            max_swappable: regular.max(swap).saturating_sub(3000),
        })
    })
    .await
    .map_err(AppError::internal)?
}

/// Last address issued per type, cached next to the wallet — the crate's
/// `get_next_external_address` always derives+increments with no "peek" mode, so this is the only
/// way to know what to re-offer instead of burning a fresh gap-limit index every call.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct LastAddresses {
    p2wpkh: Option<String>,
    p2tr: Option<String>,
}

fn resolve_last_address_path(state: &AppState) -> Result<PathBuf, AppError> {
    let data_dir = state
        .data_dir
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)?;
    let wallet = state
        .wallet
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)?;
    let wallet_name = wallet.read()?.get_name().to_string();
    Ok(data_dir
        .join("wallets")
        .join(format!("{wallet_name}_last_address.json")))
}

fn load_last_addresses(path: &PathBuf) -> LastAddresses {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_last_addresses(path: &Path, addrs: &LastAddresses) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(addrs).map_err(AppError::internal)?;
    crate::security::fs::write_private(path, json.as_bytes())
}

/// Reuses the last address issued for this type until it actually receives a payment, matching
/// the old app and standard HD-wallet gap-limit-safe behavior — repeat calls (page reload,
/// clicking Generate again) shouldn't advance the derivation index for no reason.
#[tauri::command]
pub async fn get_new_address(
    state: tauri::State<'_, AppState>,
    address_type: AddressTypeDto,
) -> Result<NewAddress, AppError> {
    let wallet = get_wallet_handle(&state)?;
    let path = resolve_last_address_path(&state)?;
    let (addr_type, label) = match address_type {
        AddressTypeDto::P2wpkh => (AddressType::P2WPKH, "p2wpkh"),
        AddressTypeDto::P2tr => (AddressType::P2TR, "p2tr"),
    };
    tauri::async_runtime::spawn_blocking(move || -> Result<NewAddress, AppError> {
        let mut cached = load_last_addresses(&path);
        let slot = match addr_type {
            AddressType::P2WPKH => &mut cached.p2wpkh,
            AddressType::P2TR => &mut cached.p2tr,
        };

        if let Some(existing) = slot.clone() {
            let used = wallet
                .read()?
                .get_transactions(None, None)?
                .into_iter()
                .any(|tx| {
                    tx.detail
                        .address
                        .is_some_and(|a| a.assume_checked().to_string() == existing)
                });
            if !used {
                return Ok(NewAddress {
                    address: existing,
                    address_type: label.to_string(),
                });
            }
        }

        let address = wallet
            .write()?
            .get_next_external_address(addr_type)?
            .to_string();
        *slot = Some(address.clone());
        save_last_addresses(&path, &cached)?;
        Ok(NewAddress {
            address,
            address_type: label.to_string(),
        })
    })
    .await
    .map_err(AppError::internal)?
}

#[tauri::command]
pub async fn get_transactions(
    state: tauri::State<'_, AppState>,
    count: Option<usize>,
    skip: Option<usize>,
) -> Result<Vec<TxSummary>, AppError> {
    let wallet = get_wallet_handle(&state)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TxSummary>, AppError> {
        let txs = wallet.read()?.get_transactions(count, skip)?;
        Ok(txs
            .into_iter()
            .map(|tx| TxSummary {
                txid: tx.info.txid.to_string(),
                category: format!("{:?}", tx.detail.category).to_lowercase(),
                amount_sats: tx.detail.amount.to_sat(),
                confirmations: tx.info.confirmations,
                address: tx.detail.address.map(|a| a.assume_checked().to_string()),
                time: tx.info.time,
                fee_sats: tx.detail.fee.map(|f| f.to_sat()),
                label: tx.detail.label,
            })
            .collect())
    })
    .await
    .map_err(AppError::internal)?
}

#[tauri::command]
pub async fn list_utxos(state: tauri::State<'_, AppState>) -> Result<Vec<UtxoEntry>, AppError> {
    let wallet = get_wallet_handle(&state)?;
    let socks_port = *state.active_socks_port.read()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<UtxoEntry>, AppError> {
        let utxos = wallet.read()?.list_all_utxo_spend_info();
        Ok(utxos
            .into_iter()
            .map(|(entry, spend_info)| UtxoEntry {
                txid: entry.txid.to_string(),
                vout: entry.vout,
                amount_sats: entry.amount.to_sat(),
                confirmations: entry.confirmations,
                address: chain_backend::utxo_address(&entry, socks_port),
                spendable: entry.spendable,
                solvable: entry.solvable,
                spend_type: spend_info.to_string(),
            })
            .collect())
    })
    .await
    .map_err(AppError::internal)?
}

/// `fee_rate` defaults to 2 sat/vB when omitted.
#[tauri::command]
pub async fn send_to_address(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    address: String,
    amount_sats: u64,
    fee_rate: Option<f64>,
    outpoints: Option<Vec<Outpoint>>,
) -> Result<SendResult, AppError> {
    ensure_main_window(&window)?;
    let address = address.trim().to_string();
    if address.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "recipient address cannot be empty",
        ));
    }
    if amount_sats == 0 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "send amount must be greater than zero",
        ));
    }
    if fee_rate.is_some_and(|rate| !rate.is_finite() || rate <= 0.0 || rate > 10_000.0) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "fee rate must be finite and between 0 and 10,000 sat/vB",
        ));
    }
    let _operation = SensitiveOperationGuard::acquire(
        &state.sensitive_operation_active,
        SensitiveOperation::SendTakerFunds,
    )?;
    let wallet = get_wallet_handle(&state)?;
    let wallet_name = wallet.read()?.get_name().to_string();
    let session_data_dir = state.data_dir.read()?.clone();
    let outpoints = outpoints
        .map(|list| {
            if list.len() > 10_000 {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "too many selected inputs",
                ));
            }
            list.into_iter()
                .map(|o| -> Result<OutPoint, AppError> {
                    let txid = Txid::from_str(&o.txid)
                        .map_err(|e| AppError::new(ErrorCode::InvalidInput, e.to_string()))?;
                    Ok(OutPoint::new(txid, o.vout))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    if outpoints.as_ref().is_some_and(|items| {
        items.iter().collect::<std::collections::HashSet<_>>().len() != items.len()
    }) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "selected inputs contain duplicates",
        ));
    }

    let fee_label = fee_rate
        .map(|rate| format!("{rate:.2} sat/vB"))
        .unwrap_or_else(|| "wallet default (2 sat/vB)".to_string());
    let input_label = outpoints
        .as_ref()
        .map(|items| {
            items
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_else(|| "automatic coin selection".to_string());
    let message = format!(
        "Wallet: {wallet_name}\n\nRecipient:\n{address}\n\nAmount: {amount_sats} sats ({:.8} BTC)\nRequested fee rate: {fee_label}\nInputs:\n{input_label}\n\nThe final network fee is constructed by the wallet. Broadcast this transaction?",
        amount_sats as f64 / 100_000_000.0
    );
    let dialog_window = window.clone();
    let approved = tauri::async_runtime::spawn_blocking(move || {
        dialog_window
            .dialog()
            .message(message)
            .parent(&dialog_window)
            .title("Confirm Bitcoin send")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Broadcast".to_string(),
                "Cancel".to_string(),
            ))
            .blocking_show()
    })
    .await
    .map_err(AppError::internal)?;
    if !approved {
        return Err(AppError::authorization_denied(
            "Bitcoin send was not approved",
        ));
    }
    if state.data_dir.read()?.as_ref() != session_data_dir.as_ref()
        || wallet.read()?.get_name() != wallet_name
    {
        return Err(AppError::new(
            ErrorCode::AuthorizationDenied,
            "wallet session changed while the send was awaiting approval",
        ));
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<SendResult, AppError> {
        let txid = wallet
            .write()?
            .send_to_address(amount_sats, address, fee_rate, outpoints)?;
        Ok(SendResult {
            txid: txid.to_string(),
        })
    })
    .await
    .map_err(AppError::internal)?
}

#[tauri::command]
pub async fn sync_wallet(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let wallet = get_wallet_handle(&state)?;
    let cancel = state.sync_cancel.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        wallet.write()?.sync_and_save(&cancel)?;
        Ok(())
    })
    .await
    .map_err(AppError::internal)?
}

/// Hits mempool.space/esplora over clearnet regardless of Tor setting.
#[tauri::command]
pub async fn estimate_fees() -> Result<FeeEstimate, AppError> {
    tauri::async_runtime::spawn_blocking(|| -> Result<FeeEstimate, AppError> {
        let estimator = FeeEstimator::new(None);
        Ok(FeeEstimate {
            high: estimator
                .get_high_priority_rate()
                .map_err(AppError::internal)?,
            mid: estimator
                .get_mid_priority_rate()
                .map_err(AppError::internal)?,
            low: estimator
                .get_low_priority_rate()
                .map_err(AppError::internal)?,
        })
    })
    .await
    .map_err(AppError::internal)?
}

/// Hits mempool.space/api/v1/prices over clearnet, same as estimate_fees — public market data,
/// not swap-sensitive, so it isn't routed through Tor. A successful quote is saved locally;
/// a later network failure falls back to that last known value across app restarts.
#[tauri::command]
pub async fn get_btc_price() -> Result<PriceEstimate, AppError> {
    tauri::async_runtime::spawn_blocking(|| -> Result<PriceEstimate, AppError> {
        let live_quote = (|| -> Result<CachedBtcPrice, AppError> {
            let response = minreq::get("https://mempool.space/api/v1/prices")
                .with_timeout(10)
                .send()
                .map_err(AppError::internal)?;
            if !(200..300).contains(&response.status_code) {
                return Err(AppError::new(
                    ErrorCode::Internal,
                    format!("price service returned HTTP {}", response.status_code),
                ));
            }
            let body: serde_json::Value = response.json().map_err(AppError::internal)?;
            let usd = body
                .get("USD")
                .and_then(serde_json::Value::as_f64)
                .filter(|price| valid_usd_price(*price))
                .ok_or_else(|| {
                    AppError::new(
                        ErrorCode::Internal,
                        "price response missing a valid USD value".to_string(),
                    )
                })?;
            Ok(CachedBtcPrice {
                usd,
                fetched_at: unix_timestamp(),
            })
        })();

        match live_quote {
            Ok(quote) => {
                if let Err(error) = save_cached_btc_price(&quote) {
                    log::warn!("could not save BTC/USD price cache: {error:?}");
                }
                Ok(PriceEstimate {
                    usd: quote.usd,
                    cached: false,
                    fetched_at: quote.fetched_at,
                })
            }
            Err(live_error) => match load_cached_btc_price() {
                Ok(Some(quote)) => {
                    log::warn!(
                        "live BTC/USD price unavailable; using cached quote from {}: {live_error:?}",
                        quote.fetched_at
                    );
                    Ok(PriceEstimate {
                        usd: quote.usd,
                        cached: true,
                        fetched_at: quote.fetched_at,
                    })
                }
                Ok(None) => Err(live_error),
                Err(cache_error) => {
                    log::warn!("could not read BTC/USD price cache: {cache_error:?}");
                    Err(live_error)
                }
            },
        }
    })
    .await
    .map_err(AppError::internal)?
}
