//! Swap execution: two-phase prepare/start, coarse in-memory progress, recovery.
//!
//! Live per-maker progress (`get_swap_tracker`) reads `coinswap::taker::swap_tracker::SwapTracker`
//! directly — a public crate API (`SwapTracker`/`SwapRecord`/`MakerProgress` are all `pub`,
//! `Serialize`/`Deserialize`), the same `<data_dir>/swap_tracker.cbor` file the old Electron app
//! polled straight off disk.

use std::str::FromStr;
use std::time::SystemTime;

use coinswap::bitcoin::{Amount, OutPoint, Txid};
use coinswap::protocol::ProtocolVersion;
use coinswap::taker::swap_tracker::{
    ExchangeProgress, LegacyExchangeProgress, MakerProgress, SwapPhase, SwapRecord, SwapTracker,
    TaprootExchangeProgress,
};
use coinswap::taker::{SwapParams, SwapSummary};
use coinswap::utill::{estimate_funding_tx_fee_sats, MIN_FEE_RATE};
use coinswap::wallet::AddressType;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::error::{AppError, ErrorCode};
use crate::security::operation::{ensure_main_window, SensitiveOperation, SensitiveOperationGuard};
use crate::state::{try_lock_taker, ActiveSwap, AppState, SwapLifecycle};
use crate::types::{
    ProtocolVersionDto, RecoveryStatus, RouterFeeInfoDto, RouterMilestoneDto, RouterProgressDto,
    RouterStageDto, SwapFundingEstimateDto, SwapProgressDto, SwapRequest, SwapSummaryDto,
    SwapTrackerDto,
};

use super::taker_wallet::get_wallet_handle;

fn protocol_label(p: ProtocolVersion) -> &'static str {
    match p {
        ProtocolVersion::Legacy => "legacy",
        ProtocolVersion::Taproot => "taproot",
    }
}

fn to_summary_dto(s: &SwapSummary) -> SwapSummaryDto {
    SwapSummaryDto {
        swap_id: s.swap_id.clone(),
        protocol: protocol_label(s.protocol).to_string(),
        send_amount_sats: s.send_amount.to_sat(),
        routers: s
            .makers
            .iter()
            .map(|m| RouterFeeInfoDto {
                address: m.address.clone(),
                protocol: protocol_label(m.protocol).to_string(),
                base_fee: m.base_fee,
                amount_relative_fee_pct: m.amount_relative_fee_pct,
                time_relative_fee_pct: m.time_relative_fee_pct,
                locktime: m.locktime,
                estimated_fee_sats: m.estimated_fee_sats,
            })
            .collect(),
        total_estimated_fee_sats: s.total_estimated_fee.to_sat(),
        estimated_receive_amount_sats: s.estimated_receive_amount.to_sat(),
    }
}

fn phase_label(phase: SwapLifecycle) -> &'static str {
    match phase {
        SwapLifecycle::Prepared => "prepared",
        SwapLifecycle::Running => "running",
        SwapLifecycle::Recovering => "recovering",
        SwapLifecycle::Finished => "finished",
        SwapLifecycle::Failed => "failed",
    }
}

fn tracker_phase_label(phase: SwapPhase) -> &'static str {
    match phase {
        SwapPhase::MakersDiscovered => "routers_discovered",
        SwapPhase::Negotiated => "negotiated",
        SwapPhase::FundingCreated => "funding_created",
        SwapPhase::FundsBroadcast => "funds_broadcast",
        SwapPhase::ContractsExchanged => "contracts_exchanged",
        SwapPhase::Finalizing => "finalizing",
        SwapPhase::PrivkeysForwarded => "privkeys_forwarded",
        SwapPhase::Completed => "completed",
        SwapPhase::Failed => "failed",
    }
}

fn legacy_milestones(p: &LegacyExchangeProgress) -> Vec<(&'static str, bool)> {
    vec![
        ("connected", p.connected),
        ("sender_sigs_requested", p.sender_sigs_requested),
        ("sender_sigs_received", p.sender_sigs_received),
        ("prev_funding_broadcast", p.prev_funding_broadcast),
        ("prev_funding_confirmed", p.prev_funding_confirmed),
        ("proof_of_funding_sent", p.proof_of_funding_sent),
        ("maker_contracts_received", p.maker_contracts_received),
        ("next_maker_sigs_obtained", p.next_maker_sigs_obtained),
        ("prev_maker_sigs_obtained", p.prev_maker_sigs_obtained),
        ("combined_sigs_sent", p.combined_sigs_sent),
        ("maker_funding_confirmed", p.maker_funding_confirmed),
        ("watchonly_created", p.watchonly_created),
    ]
}

fn taproot_milestones(p: &TaprootExchangeProgress) -> Vec<(&'static str, bool)> {
    vec![
        ("connected", p.connected),
        ("contract_data_sent", p.contract_data_sent),
        ("maker_contract_received", p.maker_contract_received),
        ("swapcoins_created", p.swapcoins_created),
        ("maker_funding_confirmed", p.maker_funding_confirmed),
    ]
}

/// Collapse a maker's flags onto the stage the UI narrates.
///
/// Both protocols park the taker on a confirmation wait immediately after one specific flag, so
/// that flag — not a step count — is what says "this hop is waiting on the chain now".
fn router_stage(m: &MakerProgress) -> RouterStageDto {
    if m.finalization.privkey_forwarded {
        return RouterStageDto::Settled;
    }
    if m.finalization.privkey_received {
        return RouterStageDto::KeyReceived;
    }
    let (confirmed, awaiting_confirmation, connected) = match &m.exchange {
        ExchangeProgress::Taproot(p) => {
            (p.maker_funding_confirmed, p.contract_data_sent, p.connected)
        }
        ExchangeProgress::Legacy(p) => (
            p.maker_funding_confirmed,
            // Two waits per legacy hop: the previous hop's funding before the proof of funding
            // goes out, and this maker's own funding once it has the combined signatures.
            p.combined_sigs_sent || (p.prev_funding_broadcast && !p.prev_funding_confirmed),
            p.connected,
        ),
    };
    if confirmed {
        RouterStageDto::Routed
    } else if awaiting_confirmation {
        RouterStageDto::Confirming
    } else if connected {
        RouterStageDto::Handshaking
    } else if m.negotiated {
        RouterStageDto::Negotiated
    } else {
        RouterStageDto::Waiting
    }
}

fn to_router_progress_dto(m: &MakerProgress) -> RouterProgressDto {
    let mut flags = vec![("negotiated", m.negotiated)];
    flags.extend(match &m.exchange {
        ExchangeProgress::Legacy(p) => legacy_milestones(p),
        ExchangeProgress::Taproot(p) => taproot_milestones(p),
    });
    flags.push(("privkey_received", m.finalization.privkey_received));
    flags.push(("privkey_forwarded", m.finalization.privkey_forwarded));
    RouterProgressDto {
        address: m.address.clone(),
        stage: router_stage(m),
        milestones: flags
            .into_iter()
            .map(|(key, done)| RouterMilestoneDto { key, done })
            .collect(),
    }
}

fn to_tracker_dto(r: &SwapRecord) -> SwapTrackerDto {
    let mut routers: Vec<RouterProgressDto> = r.makers.iter().map(to_router_progress_dto).collect();

    // Taproot sets all five of a maker's exchange flags in one write, *after* the wait for that
    // maker's contract to confirm — so the maker whose turn it is reads as untouched for the
    // whole hop, which is the longest stretch of the swap. `FundsBroadcast` is exactly the phase
    // the per-maker exchange loop runs in, so inside it the first unstarted maker is in flight,
    // and confirmation is what it is overwhelmingly waiting on.
    if r.phase == SwapPhase::FundsBroadcast {
        if let Some(front) = routers
            .iter()
            .position(|x| x.stage <= RouterStageDto::Negotiated)
        {
            if routers[..front]
                .iter()
                .all(|x| x.stage >= RouterStageDto::Routed)
            {
                routers[front].stage = RouterStageDto::Confirming;
            }
        }
    }

    SwapTrackerDto {
        phase: tracker_phase_label(r.phase).to_string(),
        send_amount_sats: r.send_amount_sat,
        router_count: r.maker_count,
        failure_reason: r.failure_reason.clone(),
        routers,
    }
}

/// Mirrors `contract_and_timelock_vsize(_, ContractSpend { cooperative: true })`, which is
/// `pub(crate)` along with its size constants. Cooperative is the success path — the
/// script-path sizes only apply to hashlock recovery, which a quote isn't describing.
const TAPROOT_SWEEP_VBYTES: u64 = 112;
const LEGACY_SWEEP_VBYTES: u64 = 150;

/// Quote every on-chain cost the taker bears directly: the initial funding transaction (same
/// wallet coin selection and fixed protocol fee rate the swap itself uses), the per-hop mining
/// fee each maker deducts from the routed amount, and the sweep that claims the incoming
/// contract at the end.
#[tauri::command]
pub async fn estimate_swap_funding(
    state: tauri::State<'_, AppState>,
    amount_sats: u64,
    protocol: ProtocolVersionDto,
    outpoints: Option<Vec<crate::types::Outpoint>>,
) -> Result<SwapFundingEstimateDto, AppError> {
    let wallet = get_wallet_handle(&state)?;
    let sweep_vbytes = match protocol {
        ProtocolVersionDto::Taproot => TAPROOT_SWEEP_VBYTES,
        ProtocolVersionDto::Legacy => LEGACY_SWEEP_VBYTES,
    };
    let outpoints = outpoints
        .map(|items| {
            items
                .into_iter()
                .map(|item| {
                    let txid = Txid::from_str(&item.txid)
                        .map_err(|e| AppError::new(ErrorCode::InvalidInput, e.to_string()))?;
                    Ok(OutPoint::new(txid, item.vout))
                })
                .collect::<Result<Vec<_>, AppError>>()
        })
        .transpose()?;

    tauri::async_runtime::spawn_blocking(move || -> Result<SwapFundingEstimateDto, AppError> {
        let wallet = wallet.read()?;
        let selected = wallet.coin_select(
            Amount::from_sat(amount_sats),
            MIN_FEE_RATE,
            AddressType::P2TR,
            outpoints,
            None,
        )?;

        // Exact weight constants used by Wallet::coin_select: base transaction,
        // selected inputs, one P2TR swap output, and one P2TR change output.
        const BASE_TX_WEIGHT: u64 = 42;
        const INPUT_BASE_WEIGHT: u64 = 164;
        const P2TR_OUTPUT_WEIGHT: u64 = 172;
        let input_weight: u64 = selected
            .iter()
            .map(|(_, spend)| INPUT_BASE_WEIGHT + spend.estimate_witness_size() as u64)
            .sum();
        let weight = BASE_TX_WEIGHT + input_weight + 2 * P2TR_OUTPUT_WEIGHT;
        let vbytes = weight.div_ceil(4);
        let fee_sats = (vbytes as f64 * MIN_FEE_RATE).ceil() as u64;

        Ok(SwapFundingEstimateDto {
            input_count: selected.len(),
            vbytes,
            fee_sats,
            fee_rate_sats_per_vb: MIN_FEE_RATE,
            route_mining_fee_per_router_sats: estimate_funding_tx_fee_sats(),
            // Truncating, not rounded up: matches the crate's own
            // `Amount::from_sat((feerate * vsize as f64) as u64)`.
            sweep_fee_sats: (sweep_vbytes as f64 * MIN_FEE_RATE) as u64,
        })
    })
    .await
    .map_err(AppError::internal)?
}

/// Phase 1: maker discovery + negotiation, no funds committed. Summary is
/// for a confirmation screen before calling start_swap.
#[tauri::command]
pub async fn prepare_swap(
    state: tauri::State<'_, AppState>,
    request: SwapRequest,
) -> Result<SwapSummaryDto, AppError> {
    if let Some(active) = state.active_swap.lock()?.as_ref() {
        if active.phase == SwapLifecycle::Running {
            return Err(AppError::swap_in_progress());
        }
    }
    if request.router_count < 2 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "routerCount must be at least 2 for route privacy",
        ));
    }

    let protocol = match request.protocol {
        ProtocolVersionDto::Legacy => ProtocolVersion::Legacy,
        ProtocolVersionDto::Taproot => ProtocolVersion::Taproot,
    };
    let mut params = SwapParams::new(
        protocol,
        Amount::from_sat(request.amount_sats),
        request.router_count,
    );
    if let Some(outpoints) = request.outpoints {
        let converted = outpoints
            .into_iter()
            .map(|o| -> Result<OutPoint, AppError> {
                let txid = Txid::from_str(&o.txid)
                    .map_err(|e| AppError::new(ErrorCode::InvalidInput, e.to_string()))?;
                Ok(OutPoint::new(txid, o.vout))
            })
            .collect::<Result<Vec<_>, _>>()?;
        params = params.with_utxos(converted);
    }
    if let Some(preferred) = request.preferred_routers {
        params = params.with_preferred_makers(preferred);
    }

    let taker = state.taker.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || -> Result<SwapSummary, AppError> {
        let mut guard = try_lock_taker(&taker)?;
        let taker = guard.as_mut().ok_or_else(AppError::not_initialized)?;
        Ok(taker.prepare_coinswap(params)?)
    })
    .await
    .map_err(AppError::internal)??;

    let dto = to_summary_dto(&summary);
    let active_backend = state
        .active_chain_backend
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)?;
    let active_socks_port = *state.active_socks_port.read()?;
    *state.active_swap.lock()? = Some(ActiveSwap {
        swap_id: summary.swap_id,
        phase: SwapLifecycle::Prepared,
        prepared: Some(dto.clone()),
        backend_fingerprint: crate::commands::chain_backend::fingerprint(
            &active_backend,
            active_socks_port,
        ),
        started_at: None,
        error: None,
    });
    Ok(dto)
}

/// Phase 2: commits funds, can run for hours — dedicated thread, not
/// spawn_blocking. Result via swap://finished / swap://failed events.
#[tauri::command]
pub async fn start_swap(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    swap_id: String,
) -> Result<(), AppError> {
    ensure_main_window(&window)?;
    let _operation = SensitiveOperationGuard::acquire(
        &state.sensitive_operation_active,
        SensitiveOperation::StartSwap,
    )?;
    let prepared = {
        let guard = state.active_swap.lock()?;
        match guard.as_ref() {
            Some(active)
                if active.swap_id == swap_id && active.phase == SwapLifecycle::Prepared =>
            {
                active.prepared.clone().ok_or_else(|| {
                    AppError::new(ErrorCode::InvalidInput, "prepared swap summary is missing")
                })?
            }
            Some(active) if active.phase == SwapLifecycle::Running => {
                return Err(AppError::swap_in_progress())
            }
            _ => {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "no prepared swap with this id — call prepare_swap first",
                ))
            }
        }
    };
    let preflight_fingerprint = crate::commands::chain_backend::preflight_active(&state).await?;
    let expected_fingerprint = state
        .active_swap
        .lock()?
        .as_ref()
        .map(|active| active.backend_fingerprint.clone())
        .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "prepared swap disappeared"))?;
    if preflight_fingerprint != expected_fingerprint {
        return Err(AppError::new(
            ErrorCode::BackendRouteChanged,
            "active backend route changed after swap preparation",
        ));
    }
    let route = {
        let config = state
            .active_chain_backend
            .read()?
            .clone()
            .ok_or_else(AppError::not_initialized)?;
        let socks_port = *state.active_socks_port.read()?;
        crate::commands::chain_backend::route_description(&config, socks_port)
    };
    let router_list = prepared
        .routers
        .iter()
        .map(|router| router.address.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let message = format!(
        "Protocol: {}\nChain data route: {}\nSend: {} sats ({:.8} BTC)\nEstimated receive: {} sats\nEstimated total fee: {} sats\nRouters ({}):\n{}\n\nPreparing did not move funds. Starting now may commit funds for the duration of the swap. Start this swap?",
        prepared.protocol,
        route,
        prepared.send_amount_sats,
        prepared.send_amount_sats as f64 / 100_000_000.0,
        prepared.estimated_receive_amount_sats,
        prepared.total_estimated_fee_sats,
        prepared.routers.len(),
        router_list,
    );
    let dialog_window = window.clone();
    let approved = tauri::async_runtime::spawn_blocking(move || {
        dialog_window
            .dialog()
            .message(message)
            .parent(&dialog_window)
            .title("Confirm Coinswap")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Start swap".to_string(),
                "Cancel".to_string(),
            ))
            .blocking_show()
    })
    .await
    .map_err(AppError::internal)?;
    if !approved {
        return Err(AppError::authorization_denied(
            "swap start was not approved",
        ));
    }
    {
        let mut guard = state.active_swap.lock()?;
        match guard.as_mut() {
            Some(active)
                if active.swap_id == swap_id && active.phase == SwapLifecycle::Prepared =>
            {
                if active.backend_fingerprint != preflight_fingerprint {
                    return Err(AppError::new(
                        ErrorCode::BackendRouteChanged,
                        "backend route changed while awaiting swap approval",
                    ));
                }
                active.phase = SwapLifecycle::Running;
                active.started_at = Some(SystemTime::now());
            }
            Some(active) if active.phase == SwapLifecycle::Running => {
                return Err(AppError::swap_in_progress())
            }
            _ => {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "no prepared swap with this id — call prepare_swap first",
                ))
            }
        }
    }

    let taker = state.taker.clone();
    std::thread::spawn(move || {
        let result = {
            let mut guard = match taker.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            match guard.as_mut() {
                Some(taker) => taker.start_coinswap(&swap_id),
                None => return, // taker dropped (app shutting down) mid-swap
            }
        };

        let app_state = app.state::<AppState>();
        let mut active_guard = match app_state.active_swap.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match result {
            // Crate already persists the report to <wallet>_swap_report.json.
            Ok(_report) => {
                if let Some(active) = active_guard.as_mut() {
                    active.phase = SwapLifecycle::Finished;
                }
                let _ = app.emit("swap://finished", &swap_id);
            }
            Err(e) => {
                // ContractsBroadcasted: funds on-chain, crate already started
                // recovery — still "failed" here, UI routes it to Recovery.
                let app_err = AppError::from(e);
                if let Some(active) = active_guard.as_mut() {
                    active.phase = SwapLifecycle::Failed;
                    active.error = Some(app_err.message.clone());
                }
                let _ = app.emit("swap://failed", &app_err);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn get_swap_progress(
    state: tauri::State<'_, AppState>,
) -> Result<Option<SwapProgressDto>, AppError> {
    let guard = state.active_swap.lock()?;
    // Only Running/Recovering is worth reconciling after a remount — a terminal phase is stale
    // by definition and would otherwise resurrect the last outcome indefinitely.
    Ok(guard
        .as_ref()
        .filter(|a| matches!(a.phase, SwapLifecycle::Running | SwapLifecycle::Recovering))
        .map(|active| SwapProgressDto {
            swap_id: active.swap_id.clone(),
            phase: phase_label(active.phase).to_string(),
            started_at: active
                .started_at
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
            error: active.error.clone(),
        }))
}

/// Live per-maker detail for the active swap, straight off `<data_dir>/swap_tracker.cbor` —
/// intended to be polled every couple seconds while a swap is running, same cadence as the old
/// Electron app's disk-read poll.
#[tauri::command]
pub async fn get_swap_tracker(
    state: tauri::State<'_, AppState>,
) -> Result<Option<SwapTrackerDto>, AppError> {
    let swap_id = state
        .active_swap
        .lock()?
        .as_ref()
        .map(|a| a.swap_id.clone());
    let Some(swap_id) = swap_id else {
        return Ok(None);
    };
    let data_dir = state
        .data_dir
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<Option<SwapTrackerDto>, AppError> {
        let tracker = SwapTracker::load_or_create(&data_dir)?;
        Ok(tracker.get_record(&swap_id).map(to_tracker_dto))
    })
    .await
    .map_err(AppError::internal)?
}

/// Manual backout trigger; also works cross-session after a crash.
#[tauri::command]
pub async fn recover_swap(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let taker = state.taker.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let mut guard = try_lock_taker(&taker)?;
        let taker = guard.as_mut().ok_or_else(AppError::not_initialized)?;
        Ok(taker.recover_active_swap()?)
    })
    .await
    .map_err(AppError::internal)??;

    if let Some(active) = state.active_swap.lock()?.as_mut() {
        active.phase = SwapLifecycle::Recovering;
    }
    Ok(())
}

#[tauri::command]
pub fn get_recovery_status(state: tauri::State<'_, AppState>) -> Result<RecoveryStatus, AppError> {
    let taker_guard = try_lock_taker(&state.taker)?;
    let taker = taker_guard.as_ref().ok_or_else(AppError::not_initialized)?;
    let complete = taker.is_recovery_complete();

    let wallet = state
        .wallet
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)?;
    let pending_contract_count = wallet.read()?.list_live_contract_spend_info().len();

    let recovering = state
        .active_swap
        .lock()?
        .as_ref()
        .map(|a| a.phase == SwapLifecycle::Recovering)
        .unwrap_or(false)
        || (pending_contract_count > 0 && !complete);

    Ok(RecoveryStatus {
        recovering,
        complete,
        pending_contract_count,
    })
}
