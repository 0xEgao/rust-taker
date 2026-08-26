//! Multi-maker lifecycle. Registrations and wallets persist on disk; live
//! `MakerServer` objects exist only in this app process and never auto-start.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use coinswap::maker::api::MIN_SWAP_AMOUNT;
use coinswap::maker::{start_server, MakerServer, MakerServerConfig};
use coinswap::utill::get_maker_dir;
use coinswap::wallet::Wallet;
use tauri::{Emitter, Manager};

use crate::commands::chain_backend;
use crate::commands::maker_settings;
use crate::commands::taker_wallet::wallet_path;
use crate::error::{from_wallet_join_error, AppError, ErrorCode};
use crate::security::input::{validate_leaf_name, validate_password, validate_tor_control_secret};
use crate::state::{try_lock_makers, AppState, MakerHandle, MakerRuntime};
use crate::types::{
    MakerInitConfig, MakerPhase, MakerPhaseEvent, MakerSettingsDto, MakerStatusDto, WalletInfo,
};

const MIN_FIDELITY_TIMELOCK: u32 = 12_960;
const MAX_FIDELITY_TIMELOCK: u32 = 25_920;

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

fn default_maker_data_dir(maker_id: &str) -> Result<PathBuf, AppError> {
    let legacy = get_maker_dir()?;
    Ok(legacy
        .parent()
        .map(|base| base.join(maker_id))
        .unwrap_or_else(|| legacy.join(maker_id)))
}

fn resolve_maker_data_dir(config: &MakerInitConfig) -> Result<PathBuf, AppError> {
    match &config.data_dir {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => default_maker_data_dir(&config.maker_id),
    }
}

fn validate_maker_config(config: &MakerInitConfig) -> Result<(), AppError> {
    let invalid = |msg: String| AppError::new(ErrorCode::InvalidInput, msg);
    if !valid_id(config.maker_id.trim()) {
        return Err(invalid(
            "makerId must contain only letters, numbers, '-' or '_'".to_string(),
        ));
    }
    validate_leaf_name(&config.wallet_name, "walletName")?;

    let ports = [
        ("networkPort", config.network_port),
        ("rpcPort", config.rpc_port),
        ("socksPort", config.socks_port),
        ("controlPort", config.control_port),
    ];
    for (name, port) in ports {
        if port == 0 {
            return Err(invalid(format!("{name} must be between 1 and 65535")));
        }
    }
    for i in 0..ports.len() {
        for j in (i + 1)..ports.len() {
            if ports[i].1 == ports[j].1 {
                return Err(invalid(format!(
                    "{} and {} cannot use the same port ({})",
                    ports[i].0, ports[j].0, ports[i].1
                )));
            }
        }
    }
    if !(MIN_FIDELITY_TIMELOCK..=MAX_FIDELITY_TIMELOCK).contains(&config.fidelity_timelock) {
        return Err(invalid(format!(
            "fidelityTimelock must be between {MIN_FIDELITY_TIMELOCK} and {MAX_FIDELITY_TIMELOCK} blocks"
        )));
    }
    if config.min_swap_amount < MIN_SWAP_AMOUNT {
        return Err(invalid(format!(
            "minSwapAmount must be at least {MIN_SWAP_AMOUNT} sats"
        )));
    }
    if config.fidelity_amount == 0 {
        return Err(invalid("fidelityAmount must be greater than 0".to_string()));
    }
    if config.required_confirms == 0 {
        return Err(invalid("requiredConfirms must be at least 1".to_string()));
    }
    for (name, value) in [
        ("amountRelativeFeePct", config.amount_relative_fee_pct),
        ("timeRelativeFeePct", config.time_relative_fee_pct),
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(invalid(format!("{name} must be finite and non-negative")));
        }
    }
    Ok(())
}

fn build_config(config: MakerInitConfig, data_dir: PathBuf) -> Result<MakerServerConfig, AppError> {
    let backend = chain_backend::resolve(&config.wallet_name, Some(config.socks_port))?;
    Ok(MakerServerConfig {
        data_dir,
        network_port: config.network_port,
        rpc_port: config.rpc_port,
        base_fee: config.base_fee,
        amount_relative_fee_pct: config.amount_relative_fee_pct,
        time_relative_fee_pct: config.time_relative_fee_pct,
        min_swap_amount: config.min_swap_amount,
        required_confirms: config.required_confirms,
        fidelity_amount: config.fidelity_amount,
        fidelity_timelock: config.fidelity_timelock,
        backend,
        wallet_name: config.wallet_name,
        control_port: config.control_port,
        socks_port: config.socks_port,
        tor_auth_password: config.tor_auth_password.unwrap_or_default(),
        password: config.wallet_password,
        ..MakerServerConfig::default()
    })
}

async fn construct_server(
    config: MakerInitConfig,
    data_dir: PathBuf,
) -> Result<Arc<MakerServer>, AppError> {
    let server_config = build_config(config, data_dir)?;
    let server = tauri::async_runtime::spawn_blocking(move || MakerServer::init(server_config))
        .await
        .map_err(from_wallet_join_error)?
        .map_err(AppError::from)?;
    Ok(Arc::new(server))
}

/// Unwinds a failed `init_maker` so the attempt can be retried.
///
/// `init_maker` proves the wallet file is absent before `MakerServer::init` runs, so anything
/// at that path afterwards was created by this attempt — `MakerServer::init` goes through
/// `Wallet::load_or_init` and can create the wallet before a later step (sync, watch service,
/// report load) fails. Leaving it behind would make the pre-existence check reject every
/// retry of the same wallet name, and no command can register an already-created wallet.
fn abort_failed_creation(
    app: &tauri::AppHandle,
    maker_id: &str,
    wallet_file: &Path,
    error: &AppError,
) -> Result<(), AppError> {
    match std::fs::remove_file(wallet_file) {
        Ok(()) => log::info!(
            "removed wallet from failed maker creation: {}",
            wallet_file.display()
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!(
            "could not remove wallet from failed maker creation {}: {e}",
            wallet_file.display()
        ),
    }
    app.state::<AppState>().makers.lock()?.remove(maker_id);
    crate::logging::unregister_maker(maker_id);
    emit_phase(
        app,
        maker_id,
        MakerPhase::Failed {
            message: error.message.clone(),
        },
    );
    Ok(())
}

pub(crate) fn read_tor_hostname(data_dir: &Path) -> Option<String> {
    let bytes = std::fs::read(data_dir.join("tor/hostname")).ok()?;
    if let Ok(hostname) = serde_cbor::from_slice::<String>(&bytes) {
        return Some(hostname);
    }
    let [_, hostname]: [String; 2] = serde_cbor::from_slice(&bytes).ok()?;
    Some(hostname)
}

fn emit_phase(app: &tauri::AppHandle, maker_id: &str, phase: MakerPhase) {
    let _ = app.emit(
        "maker://phase-changed",
        MakerPhaseEvent {
            maker_id: maker_id.to_string(),
            phase,
        },
    );
}

fn ensure_unique_registration(
    maker_id: &str,
    data_dir: &Path,
    network_port: u16,
    rpc_port: u16,
) -> Result<(), AppError> {
    for saved in maker_settings::load_all()?.values() {
        if saved.maker_id == maker_id {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "maker ID is already registered",
            ));
        }
        if saved.data_dir.as_deref().map(Path::new) == Some(data_dir) {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "another maker already uses this data directory",
            ));
        }
        if [saved.network_port, saved.rpc_port].contains(&network_port)
            || [saved.network_port, saved.rpc_port].contains(&rpc_port)
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "maker network/RPC port is already registered",
            ));
        }
    }
    Ok(())
}

fn ensure_unique_settings_update(settings: &MakerSettingsDto) -> Result<(), AppError> {
    for saved in maker_settings::load_all()?.values() {
        if saved.maker_id == settings.maker_id {
            continue;
        }
        if [saved.network_port, saved.rpc_port].contains(&settings.network_port)
            || [saved.network_port, saved.rpc_port].contains(&settings.rpc_port)
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "maker network/RPC port is already registered",
            ));
        }
    }
    Ok(())
}

/// Creates and registers a new maker wallet. This does not start its server.
#[tauri::command]
pub async fn init_maker(
    app: tauri::AppHandle,
    mut config: MakerInitConfig,
) -> Result<MakerStatusDto, AppError> {
    config.maker_id = config.maker_id.trim().to_string();
    config.wallet_name = config.wallet_name.trim().to_string();
    validate_maker_config(&config)?;
    let password = config.wallet_password.as_deref().ok_or_else(|| {
        AppError::new(
            ErrorCode::InvalidInput,
            "Portal-created makers require a wallet password",
        )
    })?;
    validate_password(password, "maker wallet password")?;
    if let Some(secret) = config.tor_auth_password.as_deref() {
        validate_tor_control_secret(secret)?;
        if !secret.is_empty() {
            *app.state::<AppState>().tor_auth_secret.lock()? =
                Some(zeroize::Zeroizing::new(secret.to_string()));
        }
    }
    if config
        .tor_auth_password
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        config.tor_auth_password = app
            .state::<AppState>()
            .tor_auth_secret
            .lock()?
            .as_ref()
            .map(|secret| secret.to_string());
    }
    let maker_id = config.maker_id.clone();
    let data_dir = resolve_maker_data_dir(&config)?;
    if config.data_dir.is_some() && data_dir.exists() {
        crate::security::fs::require_private_dir(&data_dir)?;
    } else {
        crate::security::fs::ensure_private_dir(&data_dir)?;
    }
    crate::security::fs::ensure_private_dir(&data_dir.join("wallets"))?;
    ensure_unique_registration(&maker_id, &data_dir, config.network_port, config.rpc_port)?;
    // `ensure_unique_registration` has already ruled out a registration for this ID or data
    // directory, so a wallet sitting here has none — and nothing can register an existing one.
    let wallet_file = wallet_path(&data_dir, &config.wallet_name);
    if wallet_file.exists() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            format!(
                "a wallet named '{}' already exists in this data directory — choose a different \
                 wallet name or data directory",
                config.wallet_name
            ),
        ));
    }

    let settings = MakerSettingsDto::from_init(&config, &data_dir);
    {
        let state = app.state::<AppState>();
        let mut makers = try_lock_makers(&state.makers)?;
        if makers.contains_key(&maker_id) {
            return Err(AppError::new(
                ErrorCode::MakerBusy,
                "maker is already being created",
            ));
        }
        if makers.values().any(|entry| {
            entry.settings.data_dir.as_deref().map(Path::new) == Some(data_dir.as_path())
                || [entry.settings.network_port, entry.settings.rpc_port]
                    .contains(&config.network_port)
                || [entry.settings.network_port, entry.settings.rpc_port].contains(&config.rpc_port)
        }) {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "another maker creation is already reserving this data directory or port",
            ));
        }
        makers.insert(
            maker_id.clone(),
            MakerHandle {
                settings: settings.clone(),
                runtime: None,
                phase: MakerPhase::Initializing,
                generation: 0,
            },
        );
    }
    emit_phase(&app, &maker_id, MakerPhase::Initializing);

    crate::logging::register_maker(maker_id.clone(), data_dir.clone(), settings.network_port);
    let server = match construct_server(config, data_dir.clone()).await {
        Ok(server) => server,
        Err(error) => {
            abort_failed_creation(&app, &maker_id, &wallet_file, &error)?;
            return Err(error);
        }
    };
    if let Err(error) = maker_settings::write_runtime_config(&settings)
        .and_then(|_| maker_settings::save(&settings))
    {
        server.watch_service.shutdown();
        drop(server);
        abort_failed_creation(&app, &maker_id, &wallet_file, &error)?;
        return Err(error);
    }
    // `MakerServer::init` is the crate's only wallet create/load API and starts
    // a watch service as a side effect. Creation is registration-only here, so
    // stop that temporary service and reconstruct a fresh runtime on start.
    server.watch_service.shutdown();
    drop(server);

    let network_port = settings.network_port;
    let state = app.state::<AppState>();
    let mut makers = state.makers.lock()?;
    let entry = makers
        .get_mut(&maker_id)
        .ok_or_else(|| AppError::maker_not_found(&maker_id))?;
    entry.runtime = None;
    entry.phase = MakerPhase::Stopped;
    drop(makers);
    emit_phase(&app, &maker_id, MakerPhase::Stopped);

    Ok(MakerStatusDto {
        maker_id,
        phase: MakerPhase::Stopped,
        running: false,
        tor_address: None,
        network_port,
        wallet_encrypted: Some(true),
    })
}

/// Updates a stopped maker's persisted configuration. Wallet identity and
/// storage location are immutable; changing them would silently point the
/// registration at a different wallet. A fresh runtime reads these settings
/// the next time the maker starts.
#[tauri::command]
pub fn update_maker_settings(
    state: tauri::State<'_, AppState>,
    maker_id: String,
    mut settings: MakerSettingsDto,
) -> Result<MakerSettingsDto, AppError> {
    let existing =
        maker_settings::load(&maker_id)?.ok_or_else(|| AppError::maker_not_found(&maker_id))?;
    if settings.maker_id != maker_id {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "maker ID cannot be changed",
        ));
    }
    if settings.wallet_name != existing.wallet_name || settings.data_dir != existing.data_dir {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "maker wallet name and data directory cannot be changed",
        ));
    }

    // Credentials are process-only and must never enter the settings file.
    settings.tor_auth_password = None;
    validate_maker_config(&settings.clone().into_init(None))?;
    ensure_unique_settings_update(&settings)?;

    let mut makers = try_lock_makers(&state.makers)?;
    if let Some(entry) = makers.get(&maker_id) {
        let runtime_thread_is_active = entry
            .runtime
            .as_ref()
            .and_then(|runtime| runtime.thread.as_ref())
            .is_some_and(|thread| !thread.is_finished());
        if !matches!(entry.phase, MakerPhase::Stopped | MakerPhase::Failed { .. })
            || runtime_thread_is_active
        {
            return Err(AppError::new(
                ErrorCode::MakerBusy,
                "stop the maker before changing its settings",
            ));
        }
    }

    maker_settings::write_runtime_config(&settings)?;
    maker_settings::save(&settings)?;
    if let Some(entry) = makers.get_mut(&maker_id) {
        let tor_auth_password = entry.settings.tor_auth_password.take();
        entry.settings = settings.clone();
        entry.settings.tor_auth_password = tor_auth_password;
        entry.runtime = None;
    }
    drop(makers);

    if let Some(data_dir) = settings.data_dir.as_deref() {
        crate::logging::register_maker(maker_id, PathBuf::from(data_dir), settings.network_port);
    }
    Ok(settings)
}

fn insert_saved_registration(state: &AppState, settings: MakerSettingsDto) -> Result<(), AppError> {
    let maker_id = settings.maker_id.clone();
    let mut makers = state.makers.lock()?;
    makers.entry(maker_id).or_insert(MakerHandle {
        settings,
        runtime: None,
        phase: MakerPhase::Stopped,
        generation: 0,
    });
    Ok(())
}

/// Starts a registered maker. After a fresh app launch, the runtime is first
/// reconstructed from persisted settings and the supplied wallet password.
#[tauri::command]
pub async fn start_maker(
    app: tauri::AppHandle,
    maker_id: String,
    wallet_password: Option<String>,
    tor_auth_password: Option<String>,
) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    if let Some(secret) = tor_auth_password.as_deref() {
        validate_tor_control_secret(secret)?;
        if !secret.is_empty() {
            *state.tor_auth_secret.lock()? = Some(zeroize::Zeroizing::new(secret.to_string()));
        }
    }
    let tor_auth_password = if tor_auth_password.as_deref().unwrap_or_default().is_empty() {
        state
            .tor_auth_secret
            .lock()?
            .as_ref()
            .map(|secret| secret.to_string())
    } else {
        tor_auth_password
    };
    // Reload before every start so config.toml remains the source of truth even
    // when it was edited outside this process between maker runs.
    let persisted_settings =
        maker_settings::load(&maker_id)?.ok_or_else(|| AppError::maker_not_found(&maker_id))?;
    if !state.makers.lock()?.contains_key(&maker_id) {
        insert_saved_registration(&state, persisted_settings.clone())?;
    }

    {
        let mut makers = try_lock_makers(&state.makers)?;
        let entry = makers
            .get_mut(&maker_id)
            .ok_or_else(|| AppError::maker_not_found(&maker_id))?;
        match entry.phase {
            MakerPhase::Starting | MakerPhase::Initializing | MakerPhase::Stopping => {
                return Err(AppError::maker_busy())
            }
            MakerPhase::Running => {
                return Err(AppError::new(
                    ErrorCode::MakerAlreadyRunning,
                    "maker is already running",
                ))
            }
            _ => {}
        }
        let stored_tor_auth_password = entry.settings.tor_auth_password.take();
        entry.settings = persisted_settings;
        entry.settings.tor_auth_password = stored_tor_auth_password;
        if tor_auth_password.is_some() {
            entry.settings.tor_auth_password = tor_auth_password;
        }
        entry.phase = MakerPhase::Initializing;
        // A MakerServer owns one-shot watcher/thread-pool services. Never reuse
        // it after a stop or failed run.
        entry.runtime = None;
    }
    emit_phase(&app, &maker_id, MakerPhase::Initializing);

    let settings = {
        let makers = state.makers.lock()?;
        let entry = makers
            .get(&maker_id)
            .ok_or_else(|| AppError::maker_not_found(&maker_id))?;
        entry.settings.clone()
    };

    // Fail before wallet/runtime construction when another application or a
    // leftover maker process owns either listener. Choosing another network
    // port automatically is unsafe because an existing fidelity bond may
    // commit to this maker address.
    for (label, port) in [
        ("network", settings.network_port),
        ("RPC", settings.rpc_port),
    ] {
        if TcpListener::bind(("127.0.0.1", port)).is_err() {
            let message = format!(
                "Maker {label} port {port} is already in use. Stop the other maker process using this port before starting. Do not change the network port of a fidelity-bonded maker."
            );
            if let Some(entry) = state.makers.lock()?.get_mut(&maker_id) {
                entry.phase = MakerPhase::Failed {
                    message: message.clone(),
                };
            }
            emit_phase(
                &app,
                &maker_id,
                MakerPhase::Failed {
                    message: message.clone(),
                },
            );
            return Err(AppError::new(ErrorCode::InvalidInput, message));
        }
    }
    let config = settings.clone().into_init(wallet_password);
    if let Err(error) = validate_maker_config(&config) {
        if let Some(entry) = state.makers.lock()?.get_mut(&maker_id) {
            entry.phase = MakerPhase::Failed {
                message: error.message.clone(),
            };
        }
        emit_phase(
            &app,
            &maker_id,
            MakerPhase::Failed {
                message: error.message.clone(),
            },
        );
        return Err(error);
    }
    let data_dir = resolve_maker_data_dir(&config)?;
    crate::logging::register_maker(maker_id.clone(), data_dir.clone(), settings.network_port);
    let server = match construct_server(config, data_dir.clone()).await {
        Ok(server) => server,
        Err(error) => {
            if let Some(entry) = state.makers.lock()?.get_mut(&maker_id) {
                entry.phase = MakerPhase::Failed {
                    message: error.message.clone(),
                };
            }
            emit_phase(
                &app,
                &maker_id,
                MakerPhase::Failed {
                    message: error.message.clone(),
                },
            );
            return Err(error);
        }
    };
    let mut makers = state.makers.lock()?;
    let entry = makers
        .get_mut(&maker_id)
        .ok_or_else(|| AppError::maker_not_found(&maker_id))?;
    entry.runtime = Some(MakerRuntime {
        server,
        thread: None,
    });

    entry.generation = entry.generation.wrapping_add(1);
    let generation = entry.generation;
    let runtime = entry
        .runtime
        .as_mut()
        .ok_or_else(AppError::maker_not_initialized)?;
    runtime.server.shutdown.store(false, Ordering::Relaxed);
    runtime
        .server
        .is_setup_complete
        .store(false, Ordering::Relaxed);
    let server = runtime.server.clone();
    entry.phase = MakerPhase::Starting;

    let run_app = app.clone();
    let run_id = maker_id.clone();
    let run_server = server.clone();
    let server_thread = thread::Builder::new()
        .name(format!("maker-{maker_id}"))
        .spawn(move || {
            let cleanup_server = run_server.clone();
            let result = start_server(run_server);
            if result.is_err() {
                // `coinswap::start_server` has early error paths after it may
                // have spawned background work. Ensure those services cannot
                // outlive a failed maker runtime.
                cleanup_server.shutdown.store(true, Ordering::Relaxed);
                cleanup_server.watch_service.shutdown();
                let _ = cleanup_server.thread_pool.join_all_threads();
            }
            let phase = match result {
                Ok(()) => MakerPhase::Stopped,
                Err(e) => MakerPhase::Failed {
                    message: format!("{e:?}"),
                },
            };
            let state = run_app.state::<AppState>();
            if let Ok(mut makers) = state.makers.lock() {
                if let Some(entry) = makers.get_mut(&run_id) {
                    if entry.generation == generation
                        && !matches!(entry.phase, MakerPhase::Stopping)
                    {
                        entry.phase = phase.clone();
                        drop(makers);
                        emit_phase(&run_app, &run_id, phase);
                    }
                }
            };
        });
    let server_thread = match server_thread {
        Ok(thread) => thread,
        Err(error) => {
            runtime.server.watch_service.shutdown();
            entry.phase = MakerPhase::Failed {
                message: error.to_string(),
            };
            entry.runtime = None;
            drop(makers);
            emit_phase(
                &app,
                &maker_id,
                MakerPhase::Failed {
                    message: error.to_string(),
                },
            );
            return Err(AppError::internal(error));
        }
    };
    runtime.thread = Some(server_thread);
    drop(makers);
    emit_phase(&app, &maker_id, MakerPhase::Starting);

    let watch_app = app.clone();
    thread::spawn(move || loop {
        if server.is_setup_complete.load(Ordering::Relaxed) {
            let state = watch_app.state::<AppState>();
            if let Ok(mut makers) = state.makers.lock() {
                if let Some(entry) = makers.get_mut(&maker_id) {
                    if entry.generation == generation && matches!(entry.phase, MakerPhase::Starting)
                    {
                        entry.phase = MakerPhase::Running;
                        drop(makers);
                        emit_phase(&watch_app, &maker_id, MakerPhase::Running);
                    }
                }
            }
            break;
        }
        let keep_watching = watch_app
            .state::<AppState>()
            .makers
            .lock()
            .ok()
            .and_then(|makers| {
                makers
                    .get(&maker_id)
                    .map(|e| e.generation == generation && matches!(e.phase, MakerPhase::Starting))
            })
            .unwrap_or(false);
        if !keep_watching {
            break;
        }
        thread::sleep(Duration::from_millis(250));
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_maker(app: tauri::AppHandle, maker_id: String) -> Result<(), AppError> {
    let thread = {
        let state = app.state::<AppState>();
        let mut makers = try_lock_makers(&state.makers)?;
        let entry = makers
            .get_mut(&maker_id)
            .ok_or_else(|| AppError::maker_not_found(&maker_id))?;
        if matches!(entry.phase, MakerPhase::Initializing | MakerPhase::Stopping) {
            return Err(AppError::maker_busy());
        }
        if !matches!(entry.phase, MakerPhase::Starting | MakerPhase::Running) {
            return Err(AppError::new(
                ErrorCode::MakerNotRunning,
                "maker is not running",
            ));
        }
        entry.phase = MakerPhase::Stopping;
        let runtime = entry
            .runtime
            .as_mut()
            .ok_or_else(AppError::maker_not_initialized)?;
        runtime.server.shutdown.store(true, Ordering::Relaxed);
        runtime.thread.take()
    };
    emit_phase(&app, &maker_id, MakerPhase::Stopping);
    let join_result = if let Some(thread) = thread {
        tauri::async_runtime::spawn_blocking(move || thread.join())
            .await
            .map_err(AppError::internal)?
            .map_err(|_| AppError::new(ErrorCode::Internal, "maker server thread panicked"))
    } else {
        Ok(())
    };
    let state = app.state::<AppState>();
    if let Some(entry) = state.makers.lock()?.get_mut(&maker_id) {
        entry.runtime = None;
        entry.phase = if join_result.is_ok() {
            MakerPhase::Stopped
        } else {
            MakerPhase::Failed {
                message: "maker server thread panicked".to_string(),
            }
        };
    }
    let phase = if join_result.is_ok() {
        MakerPhase::Stopped
    } else {
        MakerPhase::Failed {
            message: "maker server thread panicked".to_string(),
        }
    };
    emit_phase(&app, &maker_id, phase);
    join_result
}

#[tauri::command]
pub fn get_maker_status(
    state: tauri::State<'_, AppState>,
    maker_id: String,
) -> Result<MakerStatusDto, AppError> {
    if !state.makers.lock()?.contains_key(&maker_id) {
        if let Some(settings) = maker_settings::load(&maker_id)? {
            insert_saved_registration(&state, settings)?;
        }
    }
    let makers = state.makers.lock()?;
    let entry = makers
        .get(&maker_id)
        .ok_or_else(|| AppError::maker_not_found(&maker_id))?;
    let (running, runtime_tor_address) = entry
        .runtime
        .as_ref()
        .map(|runtime| {
            (
                runtime.thread.as_ref().is_some_and(|t| !t.is_finished()),
                read_tor_hostname(&runtime.server.data_dir),
            )
        })
        .unwrap_or((false, None));
    let tor_address = runtime_tor_address.or_else(|| {
        entry
            .settings
            .data_dir
            .as_deref()
            .and_then(|data_dir| read_tor_hostname(Path::new(data_dir)))
    });
    let wallet_encrypted = entry.settings.data_dir.as_deref().and_then(|data_dir| {
        Wallet::is_wallet_encrypted(&wallet_path(
            Path::new(data_dir),
            &entry.settings.wallet_name,
        ))
        .ok()
    });
    Ok(MakerStatusDto {
        maker_id,
        phase: entry.phase.clone(),
        running,
        tor_address,
        network_port: entry.settings.network_port,
        wallet_encrypted,
    })
}

#[tauri::command]
pub fn get_maker_info(
    state: tauri::State<'_, AppState>,
    maker_id: String,
) -> Result<WalletInfo, AppError> {
    if !state.makers.lock()?.contains_key(&maker_id) {
        if let Some(settings) = maker_settings::load(&maker_id)? {
            insert_saved_registration(&state, settings)?;
        }
    }
    let makers = state.makers.lock()?;
    let entry = makers
        .get(&maker_id)
        .ok_or_else(|| AppError::maker_not_found(&maker_id))?;
    let data_dir = entry
        .settings
        .data_dir
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(AppError::maker_not_initialized)?;
    Ok(WalletInfo {
        wallet_path: wallet_path(&data_dir, &entry.settings.wallet_name)
            .display()
            .to_string(),
        wallet_name: entry.settings.wallet_name.clone(),
        data_dir: data_dir.display().to_string(),
    })
}

/// Signals and joins every maker. Used only during process shutdown.
pub fn shutdown_all(state: &AppState) {
    let threads = state
        .makers
        .lock()
        .map(|mut makers| {
            makers
                .values_mut()
                .filter_map(|entry| {
                    let runtime = entry.runtime.as_mut()?;
                    runtime.server.shutdown.store(true, Ordering::Relaxed);
                    runtime.thread.take()
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for thread in threads {
        let _ = thread.join();
    }
    if let Ok(mut makers) = state.makers.lock() {
        for entry in makers.values_mut() {
            entry.runtime = None;
            entry.phase = MakerPhase::Stopped;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maker_ids_are_path_safe() {
        assert!(valid_id("maker_01-test"));
        assert!(!valid_id("../maker"));
        assert!(!valid_id("maker one"));
    }

    #[test]
    fn wallet_names_are_single_components() {
        assert!(validate_leaf_name("wallet.dat", "walletName").is_ok());
        assert!(validate_leaf_name("../wallet.dat", "walletName").is_err());
        assert!(validate_leaf_name("nested/wallet.dat", "walletName").is_err());
    }
}
