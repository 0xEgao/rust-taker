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

use crate::error::{AppError, ErrorCode};
use crate::state::{try_lock_taker, ActiveSwap, AppState, SwapLifecycle};
use crate::types::{
    MakerFeeInfoDto, MakerProgressDto, ProtocolVersionDto, RecoveryStatus, SwapFundingEstimateDto,
    SwapProgressDto, SwapRequest, SwapSummaryDto, SwapTrackerDto,
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
        makers: s
            .makers
            .iter()
            .map(|m| MakerFeeInfoDto {
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
        SwapPhase::MakersDiscovered => "makers_discovered",
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

// Counts of completed vs total boolean milestones — only the counts are ever rendered (a tone,
// not a checklist), so we don't build/ship per-step labels for something nothing displays.
fn legacy_steps_done(p: &LegacyExchangeProgress) -> (usize, usize) {
    let flags = [
        p.connected,
        p.sender_sigs_requested,
        p.sender_sigs_received,
        p.prev_funding_broadcast,
        p.prev_funding_confirmed,
        p.proof_of_funding_sent,
        p.maker_contracts_received,
        p.next_maker_sigs_obtained,
        p.prev_maker_sigs_obtained,
        p.combined_sigs_sent,
        p.maker_funding_confirmed,
        p.watchonly_created,
    ];
    (flags.iter().filter(|d| **d).count(), flags.len())
}

fn taproot_steps_done(p: &TaprootExchangeProgress) -> (usize, usize) {
    let flags = [
        p.connected,
        p.contract_data_sent,
        p.maker_contract_received,
        p.swapcoins_created,
        p.maker_funding_confirmed,
    ];
    (flags.iter().filter(|d| **d).count(), flags.len())
}

fn to_maker_progress_dto(m: &MakerProgress) -> MakerProgressDto {
    let (mut done, mut total) = match &m.exchange {
        ExchangeProgress::Legacy(p) => legacy_steps_done(p),
        ExchangeProgress::Taproot(p) => taproot_steps_done(p),
    };
    done += [
        m.finalization.privkey_received,
        m.finalization.privkey_forwarded,
    ]
    .iter()
    .filter(|d| **d)
    .count();
    total += 2;
    MakerProgressDto {
        address: m.address.clone(),
        steps_done: done,
        steps_total: total,
    }
}

fn to_tracker_dto(r: &SwapRecord) -> SwapTrackerDto {
    SwapTrackerDto {
        phase: tracker_phase_label(r.phase).to_string(),
        send_amount_sats: r.send_amount_sat,
        maker_count: r.maker_count,
        failure_reason: r.failure_reason.clone(),
        makers: r.makers.iter().map(to_maker_progress_dto).collect(),
    }
}

/// Quote the taker's initial funding transaction using the same wallet coin
/// selection and fixed protocol fee rate used when the swap actually starts.
#[tauri::command]
pub async fn estimate_swap_funding(
    state: tauri::State<'_, AppState>,
    amount_sats: u64,
    outpoints: Option<Vec<crate::types::Outpoint>>,
) -> Result<SwapFundingEstimateDto, AppError> {
    let wallet = get_wallet_handle(&state)?;
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
            fee_rate: MIN_FEE_RATE,
            route_mining_fee_per_maker_sats: estimate_funding_tx_fee_sats(),
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
    if request.maker_count < 2 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "maker_count must be at least 2 for route privacy",
        ));
    }

    let protocol = match request.protocol {
        ProtocolVersionDto::Legacy => ProtocolVersion::Legacy,
        ProtocolVersionDto::Taproot => ProtocolVersion::Taproot,
    };
    let mut params = SwapParams::new(
        protocol,
        Amount::from_sat(request.amount_sats),
        request.maker_count,
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
    if let Some(preferred) = request.preferred_makers {
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
    *state.active_swap.lock()? = Some(ActiveSwap {
        swap_id: summary.swap_id,
        phase: SwapLifecycle::Prepared,
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
    state: tauri::State<'_, AppState>,
    swap_id: String,
) -> Result<(), AppError> {
    {
        let mut guard = state.active_swap.lock()?;
        match guard.as_mut() {
            Some(active)
                if active.swap_id == swap_id && active.phase == SwapLifecycle::Prepared =>
            {
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
