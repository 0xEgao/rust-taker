//! Swap reports & deniability. One consolidated file per wallet
//! (`<wallet_name>_swap_report.json`, not per swap id) written by the crate
//! itself — we only read it.

use std::path::{Path, PathBuf};
use std::str::FromStr;

use coinswap::bitcoin::{Address, Txid};
use coinswap::wallet::{AnyBlockchain, Blockchain, SwapStatus, TakerReport};

use crate::commands::chain_backend;
use crate::error::{AppError, ErrorCode};
use crate::state::{try_lock_taker, AppState};
use crate::types::{Outpoint, ReportRouterFee, SwapReportDetail, SwapReportSummary, SwapUtxoDto};

/// Mirrors the `taker` field of the crate's `wallet::report::SwapReportFile` — that wrapper type
/// isn't re-exported from `coinswap::wallet`, so this reads the same on-disk JSON shape directly
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

#[tauri::command]
pub async fn list_swap_reports(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SwapReportSummary>, AppError> {
    let path = resolve_report_path(&state)?;
    let file = tauri::async_runtime::spawn_blocking(move || load_report_file(&path))
        .await
        .map_err(AppError::internal)??;

    Ok(file
        .taker
        .iter()
        .map(|r| SwapReportSummary {
            swap_id: r.swap_id.clone(),
            status: status_label(&r.status).to_string(),
            start_timestamp: r.start_timestamp,
            end_timestamp: r.end_timestamp,
            outgoing_amount_sats: r.outgoing_amount,
            received_amount_sats: r.outgoing_amount.saturating_sub(r.fee_paid),
            fee_paid_sats: r.fee_paid,
            routers_count: r.makers_count,
        })
        .collect())
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

    let proven_outpoint = r.deniability_proof.as_ref().map(|p| {
        let op = p.proven_outpoint();
        Outpoint {
            txid: op.txid.to_string(),
            vout: op.vout,
        }
    });
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
        outgoing_contract_txid: r.outgoing_contract_txid,
        incoming_contract_txid: r.incoming_contract_txid,
        funding_txids: r.funding_txids,
        routers_count: r.makers_count,
        router_addresses: r.maker_addresses,
        router_fee_info,
        input_utxo_sats: r.input_utxos,
        change_utxo_sats: r.output_change_amounts,
        proven_outpoint,
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

        // The proof names the incoming contract outpoint exactly. Without one only the txid
        // is known, and a Taproot contract output is not necessarily vout 0 — so the sweep is
        // then matched on the whole transaction rather than on a guessed outpoint.
        let contract = report
            .deniability_proof
            .as_ref()
            .map(|p| p.proven_outpoint());
        let contract_txid = match (contract, report.incoming_contract_txid.as_deref()) {
            (Some(outpoint), _) => outpoint.txid,
            (None, Some(txid)) => Txid::from_str(txid)
                .map_err(|e| AppError::internal(format!("bad contract txid: {e}")))?,
            (None, None) => return Ok(None),
        };

        // Carries the wallet's own `vout` so the receiving output is read, not guessed —
        // a sweep's output index is not guaranteed to be 0.
        let (wallet_name, candidates) = {
            let w = wallet.read()?;
            let txs = w.get_transactions(None, None)?;
            // The sweep lands while the swap runs, so the whole wallet history is not worth
            // fetching raw; `start_timestamp` bounds it to a handful of transactions.
            let received: Vec<(Txid, u32)> = txs
                .into_iter()
                .filter(|tx| tx.info.time >= report.start_timestamp)
                .map(|tx| (tx.info.txid, tx.detail.vout))
                .collect();
            (w.get_name().to_string(), received)
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
            let spends_contract = tx.input.iter().any(|i| match contract {
                Some(outpoint) => i.previous_output == outpoint,
                None => i.previous_output.txid == contract_txid,
            });
            if !spends_contract {
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
