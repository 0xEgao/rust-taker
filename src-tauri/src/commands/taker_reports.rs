//! Swap reports & deniability. One consolidated file per wallet
//! (`<wallet_name>_swap_report.json`, not per swap id) written by the crate
//! itself — we only read it.

use std::path::{Path, PathBuf};

use openswap::bitcoin::{Address, Txid};
use openswap::taker::swap_tracker::{RecoveryPhase, SwapPhase, SwapRecord};
use openswap::wallet::{AnyBlockchain, Blockchain, SwapStatus, TakerReport, UTXOSpendInfo};

use crate::commands::chain_backend;
use crate::error::{AppError, ErrorCode};
use crate::state::{try_lock_taker, AppState};
use crate::types::{
    Outpoint, ReportRouterFee, ReportUtxo, SwapReportDetail, SwapReportSummary, SwapUtxoDto,
};

/// Mirrors the `taker` field of the crate's `wallet::report::SwapReportFile` — that wrapper type
/// isn't re-exported from `openswap::wallet`, so this reads the same on-disk JSON shape directly
/// rather than waiting on the crate to fix the re-export.
#[derive(Debug, Clone, Default, serde::Deserialize)]
struct SwapReportFile {
    #[serde(default)]
    taker: Vec<TakerReport>,
}

/// Shared with `commands::maker_reports` — both resolve the same per-wallet report file.
///
/// The crate writes `<stem>_swap_report.json`, taking the *stem* of the wallet file name
/// (`wallet::report::wallet_name_for_report`), so a wallet named `wallet.dat` reports to
/// `wallet_swap_report.json`. Formatting the full file name here instead would silently
/// read a path that never exists and report zero swaps.
pub(crate) fn report_path(data_dir: &Path, wallet_name: &str) -> PathBuf {
    let stem = Path::new(wallet_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(wallet_name);
    data_dir
        .join("wallets")
        .join(format!("{stem}_swap_report.json"))
}

/// Shared with `commands::maker_reports` — both read the same `SwapStatus` enum off the same
/// on-disk report file, just different sections of it (`taker` vs `maker`).
pub(crate) fn status_label(s: &SwapStatus) -> &'static str {
    match s {
        SwapStatus::Success => "success",
        SwapStatus::RecoveryHashlock => "recovery_hashlock",
        SwapStatus::RecoveryTimelock => "recovery_timelock",
        SwapStatus::Failed => "failed",
    }
}

pub(crate) fn to_report_utxos(utxos: Vec<openswap::wallet::ReportUtxo>) -> Vec<ReportUtxo> {
    utxos
        .into_iter()
        .map(|u| ReportUtxo {
            address: u.address,
            value_sats: u.value,
        })
        .collect()
}

fn resolve_report_path(state: &AppState) -> Result<PathBuf, AppError> {
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
    Ok(report_path(&data_dir, &wallet_name))
}

fn load_report_file(path: &PathBuf) -> Result<SwapReportFile, AppError> {
    if !path.exists() {
        return Ok(SwapReportFile::default());
    }
    let contents = std::fs::read_to_string(path)?;
    serde_json::from_str(&contents)
        .map_err(|e| AppError::internal(format!("failed to parse {}: {e}", path.display())))
}

/// Every record in `swap_tracker.cbor`, deserialised here rather than through `SwapTracker`.
///
/// Its own `incomplete_swaps()` is the only enumeration the crate exposes, and it deliberately
/// excludes a swap that failed and was then recovered — which is exactly the case that has no
/// report file entry either, so those swaps would be invisible in both places. The container is
/// one field, and `SwapRecord` is public and `Deserialize`, so this reads the same bytes the
/// crate wrote. A shape change upstream degrades to "report file only" rather than an error.
fn tracker_records(data_dir: &Path) -> Vec<SwapRecord> {
    #[derive(serde::Deserialize)]
    struct TrackerFile {
        swaps: std::collections::HashMap<String, SwapRecord>,
    }
    let path = data_dir.join("swap_tracker.cbor");
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    match serde_cbor::from_slice::<TrackerFile>(&bytes) {
        Ok(file) => file.swaps.into_values().collect(),
        Err(error) => {
            log::warn!("could not read {}: {error:?}", path.display());
            Vec::new()
        }
    }
}

#[tauri::command]
pub async fn list_swap_reports(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SwapReportSummary>, AppError> {
    let path = resolve_report_path(&state)?;
    let data_dir = state
        .data_dir
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)?;
    let file = tauri::async_runtime::spawn_blocking(move || load_report_file(&path))
        .await
        .map_err(AppError::internal)??;

    let mut rows: Vec<SwapReportSummary> = file
        .taker
        .iter()
        .map(|r| SwapReportSummary {
            swap_id: r.swap_id.clone(),
            status: status_label(&r.status).to_string(),
            reported: true,
            start_timestamp: r.start_timestamp,
            end_timestamp: Some(r.end_timestamp),
            outgoing_amount_sats: r.outgoing_amount,
            received_amount_sats: r.outgoing_amount.saturating_sub(r.fee_paid),
            fee_paid_sats: r.fee_paid,
            routers_count: r.makers_count,
        })
        .collect();

    // A report only gets written from inside `start_swap`. A swap the process never returned
    // from — the app was closed, or it crashed — is marked Failed by `cleanup_incomplete` at the
    // next launch, which writes no report at all. Those swaps really happened and may still be
    // holding funds, so listing only the report file understates what the wallet has done and
    // reports "0 failed" while money sits in a contract.
    let reported: std::collections::HashSet<String> =
        rows.iter().map(|r| r.swap_id.clone()).collect();
    for record in tracker_records(&data_dir) {
        if reported.contains(&record.swap_id) {
            continue;
        }
        let status = if record.phase == SwapPhase::Completed {
            "success"
        } else if record.phase == SwapPhase::Failed {
            if record.recovery.phase >= RecoveryPhase::CleanedUp {
                "recovered"
            } else {
                "interrupted"
            }
        } else {
            "unfinished"
        };
        rows.push(SwapReportSummary {
            swap_id: record.swap_id.clone(),
            status: status.to_string(),
            reported: false,
            start_timestamp: record.created_at,
            end_timestamp: None,
            outgoing_amount_sats: record.send_amount_sat,
            // The tracker keeps no fee figures, so nothing is invented for them.
            received_amount_sats: 0,
            fee_paid_sats: 0,
            routers_count: record.maker_count,
        });
    }
    rows.sort_by_key(|r| r.start_timestamp);
    Ok(rows)
}

#[tauri::command]
pub async fn get_swap_report(
    state: tauri::State<'_, AppState>,
    swap_id: String,
) -> Result<SwapReportDetail, AppError> {
    let path = resolve_report_path(&state)?;
    let file = tauri::async_runtime::spawn_blocking(move || load_report_file(&path))
        .await
        .map_err(AppError::internal)??;

    let r = file
        .taker
        .into_iter()
        .find(|r| r.swap_id == swap_id)
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::WalletNotFound,
                format!("no report found for swap_id {swap_id}"),
            )
        })?;

    let router_fee_info = r
        .maker_fee_info
        .into_iter()
        .map(|m| ReportRouterFee {
            router_index: m.maker_index,
            router_address: m.maker_address,
            base_fee_sats: m.base_fee,
            amount_relative_fee_sats: m.amount_relative_fee,
            time_relative_fee_sats: m.time_relative_fee,
            total_fee_sats: m.total_fee,
        })
        .collect();

    // Both sides of the route as outpoints. `proven_outpoint` is the incoming contract — the one
    // `verify_deniability` checks on-chain — and `outgoing_swapcoin` is what this wallet paid in.
    let to_outpoint = |op: openswap::bitcoin::OutPoint| Outpoint {
        txid: op.txid.to_string(),
        vout: op.vout,
    };
    let incoming_contract_outpoint = r
        .deniability_proof
        .as_ref()
        .map(|p| to_outpoint(p.proven_outpoint()));
    let outgoing_contract_outpoint = r
        .deniability_proof
        .as_ref()
        .and_then(|p| p.outgoing_swapcoin)
        .map(to_outpoint);
    // Raw pass-through — see the field's doc comment in types.rs for why this isn't hand-mirrored.
    let deniability_proof = r
        .deniability_proof
        .map(|p| serde_json::to_value(p).unwrap_or(serde_json::Value::Null));

    Ok(SwapReportDetail {
        swap_id: r.swap_id,
        status: status_label(&r.status).to_string(),
        network: r.network,
        swap_duration_seconds: r.swap_duration_seconds,
        start_timestamp: r.start_timestamp,
        end_timestamp: r.end_timestamp,
        error_message: r.error_message,
        outgoing_amount_sats: r.outgoing_amount,
        received_amount_sats: r.outgoing_amount.saturating_sub(r.fee_paid),
        fee_paid_sats: r.fee_paid,
        mining_fee_sats: r.mining_fee,
        fee_percentage: r.fee_percentage,
        total_router_fees_sats: r.total_maker_fees,
        outgoing_utxos: to_report_utxos(r.outgoing_utxos),
        incoming_utxos: to_report_utxos(r.incoming_utxos),
        funding_txids: r.funding_txids,
        routers_count: r.makers_count,
        router_addresses: r.maker_addresses,
        router_fee_info,
        outgoing_contract_outpoint,
        incoming_contract_outpoint,
        deniability_proof,
    })
}

#[tauri::command]
pub async fn verify_deniability(
    state: tauri::State<'_, AppState>,
    swap_id: String,
) -> Result<bool, AppError> {
    let taker = state.taker.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, AppError> {
        let guard = try_lock_taker(&taker)?;
        let taker = guard.as_ref().ok_or_else(AppError::not_initialized)?;
        taker
            .verify_deniability(&swap_id)
            .map_err(|e| AppError::internal(e.to_string()))
    })
    .await
    .map_err(AppError::internal)?
}

/// Recovers the coin a swap actually paid the user.
///
/// The report file can't answer this: its `output_swap_utxos` is the wallet's whole swept-coin
/// set at write time, not this swap's, and it stores bare amounts with no outpoint. So this
/// walks the chain instead — the sweep is the transaction spending the incoming contract
/// outpoint, and its output is the coin. Costs a chain round-trip per candidate, so it is a
/// separate on-demand command rather than part of `get_swap_report`.
/// Chain round-trips this lookup is willing to spend; the closest-valued candidate is almost
/// always the coin, so this only bounds a wallet that has accumulated many unspent sweeps.
const MAX_SWEPT_CANDIDATES: usize = 8;

#[tauri::command]
pub async fn get_incoming_swap_utxo(
    state: tauri::State<'_, AppState>,
    swap_id: String,
) -> Result<Option<SwapUtxoDto>, AppError> {
    let path = resolve_report_path(&state)?;
    let wallet = state
        .wallet
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)?;
    // The session config can be re-pointed mid-session; this is the route the wallet is
    // actually built against.
    let active_backend = state
        .active_chain_backend
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)?;
    let socks_port = *state.active_socks_port.read()?;

    tauri::async_runtime::spawn_blocking(move || -> Result<Option<SwapUtxoDto>, AppError> {
        let report = load_report_file(&path)?
            .taker
            .into_iter()
            .find(|r| r.swap_id == swap_id)
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::ReportNotFound,
                    format!("no router report found for swap_id {swap_id}"),
                )
            })?;

        // The proof is the only record of the incoming contract outpoint — upstream PR #1006
        // dropped the bare contract txids from the report — so a swap that produced no proof
        // cannot be matched to its sweep at all.
        let Some(contract) = report
            .deniability_proof
            .as_ref()
            .map(|p| p.proven_outpoint())
        else {
            return Ok(None);
        };

        // Deliberately not `get_transactions`: the incoming contract's script is watched
        // (`Wallet::watch_script`), so Electrum values the sweep's input as spent-by-us, marks
        // the whole transaction a send, and then skips its output back to us — the sweep is
        // absent from wallet history entirely. The crate already tags the resulting coin
        // `SweptCoin` in the local UTXO cache, which costs no round-trip at all.
        let (wallet_name, candidates) = {
            let w = wallet.read()?;
            // `fee_paid` includes the funding transaction's mining fee, which left the input
            // rather than the contract, so the report's figure lands near the coin without
            // equalling it. It only orders the candidates — the contract-outpoint check below
            // is what identifies the coin.
            let target = report.outgoing_amount.saturating_sub(report.fee_paid);
            let mut swept: Vec<(u64, Txid, u32)> = w
                .list_all_utxo_spend_info()
                .into_iter()
                .filter(|(_, info)| matches!(info, UTXOSpendInfo::SweptCoin { .. }))
                .map(|(utxo, _)| (utxo.amount.to_sat().abs_diff(target), utxo.txid, utxo.vout))
                .collect();
            swept.sort_unstable();
            swept.truncate(MAX_SWEPT_CANDIDATES);
            let ordered: Vec<(Txid, u32)> =
                swept.into_iter().map(|(_, txid, vout)| (txid, vout)).collect();
            (w.get_name().to_string(), ordered)
        };

        let backend = AnyBlockchain::from_config(&chain_backend::resolve_from(
            &active_backend,
            &wallet_name,
            socks_port,
        )?)
        .map_err(|e| AppError::internal(format!("{e:?}")))?;
        // `Wallet` keeps its network private, so the backend is the only source for the
        // address encoding.
        let network = backend
            .get_blockchain_info()
            .map(|info| info.chain)
            .map_err(|e| AppError::internal(format!("{e:?}")))?;

        for (txid, vout) in candidates {
            let Ok(tx) = backend.get_raw_transaction(&txid, None) else {
                continue;
            };
            if !tx.input.iter().any(|i| i.previous_output == contract) {
                continue;
            }
            let Some(out) = tx.output.get(vout as usize) else {
                continue;
            };
            return Ok(Some(SwapUtxoDto {
                txid: txid.to_string(),
                vout,
                amount_sats: out.value.to_sat(),
                // Decoding the script here is what gives a real address on Electrum, whose
                // `list_unspent` leaves the address blank.
                address: Address::from_script(&out.script_pubkey, network)
                    .ok()
                    .map(|a| a.to_string()),
            }));
        }
        Ok(None)
    })
    .await
    .map_err(AppError::internal)?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The crate writes reports under the wallet file's *stem*, so a dotted wallet name must
    /// not produce `wallet.dat_swap_report.json` — that path never exists and reads as zero swaps.
    #[test]
    fn report_path_uses_the_wallet_file_stem() {
        let dir = Path::new("/data");
        assert_eq!(
            report_path(dir, "wallet.dat"),
            dir.join("wallets").join("wallet_swap_report.json")
        );
        assert_eq!(
            report_path(dir, "taker-wallet"),
            dir.join("wallets").join("taker-wallet_swap_report.json")
        );
    }

    /// A dotfile name is all extension and no stem; falling back to the raw name keeps the
    /// path in the wallets directory instead of collapsing to `_swap_report.json`.
    #[test]
    fn report_path_falls_back_when_there_is_no_stem() {
        assert_eq!(
            report_path(Path::new("/data"), ".wallet"),
            Path::new("/data")
                .join("wallets")
                .join(".wallet_swap_report.json")
        );
    }
}
