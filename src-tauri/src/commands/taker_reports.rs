//! Swap reports & deniability. One consolidated file per wallet
//! (`<wallet_name>_swap_report.json`, not per swap id) written by the crate
//! itself — we only read it.

use std::path::{Path, PathBuf};

use coinswap::wallet::{SwapStatus, TakerReport};

use crate::error::{AppError, ErrorCode};
use crate::state::{try_lock_taker, AppState};
use crate::types::{MakerFeeInfo, Outpoint, SwapReportDetail, SwapReportSummary};

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
            makers_count: r.makers_count,
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

    let maker_fee_info = r
        .maker_fee_info
        .into_iter()
        .map(|m| MakerFeeInfo {
            maker_index: m.maker_index,
            maker_address: m.maker_address,
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
        total_maker_fees_sats: r.total_maker_fees,
        outgoing_contract_txid: r.outgoing_contract_txid,
        incoming_contract_txid: r.incoming_contract_txid,
        funding_txids: r.funding_txids,
        makers_count: r.makers_count,
        maker_addresses: r.maker_addresses,
        maker_fee_info,
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
