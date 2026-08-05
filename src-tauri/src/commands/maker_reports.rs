//! Maker-side swap reports & deniability — the maker's counterpart to
//! `commands::taker_reports`. Same on-disk file
//! (`<wallet_name>_swap_report.json`), different section: coinswap's
//! `SwapReportFile.maker` is a `HashMap<String, Vec<MakerReport>>` keyed by
//! maker node name (see `coinswap::wallet::report::wallet_name_for_report`,
//! not itself re-exported). Each command resolves one registered maker's
//! report file and flattens the node-name buckets stored within that file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use coinswap::maker::MakerServer;
use coinswap::wallet::MakerReport;

use crate::commands::maker_settings;
use crate::commands::taker_reports::status_label;
use crate::error::{AppError, ErrorCode};
use crate::state::AppState;
use crate::types::{MakerSwapReportDetail, MakerSwapReportSummary};

fn get_maker_server(state: &AppState, maker_id: &str) -> Result<Arc<MakerServer>, AppError> {
    let makers = state.makers.lock()?;
    let entry = makers
        .get(maker_id)
        .ok_or_else(|| AppError::maker_not_found(maker_id))?;
    entry
        .runtime
        .as_ref()
        .map(|runtime| runtime.server.clone())
        .ok_or_else(AppError::maker_not_initialized)
}

/// Mirrors `taker_reports.rs`'s own local `SwapReportFile` — the wrapper type isn't re-exported
/// from `coinswap::wallet` (see that file's doc comment), so both read the on-disk JSON shape
/// directly rather than waiting on the crate to fix the re-export. Only the field this file
/// needs is declared; `taker`/`recovery`/`deniability_proofs` are ignored here.
#[derive(Debug, Clone, Default, serde::Deserialize)]
struct SwapReportFile {
    #[serde(default)]
    maker: HashMap<String, Vec<MakerReport>>,
}

fn resolve_report_path(state: &AppState, maker_id: &str) -> Result<PathBuf, AppError> {
    let makers = state.makers.lock()?;
    let in_memory = makers.get(maker_id).map(|entry| entry.settings.clone());
    drop(makers);
    let settings = match in_memory {
        Some(settings) => settings,
        None => {
            maker_settings::load(maker_id)?.ok_or_else(|| AppError::maker_not_found(maker_id))?
        }
    };
    let data_dir = settings
        .data_dir
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(AppError::maker_not_initialized)?;
    let wallet_name = settings.wallet_name;
    Ok(data_dir
        .join("wallets")
        .join(format!("{wallet_name}_swap_report.json")))
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
pub async fn list_maker_swap_reports(
    state: tauri::State<'_, AppState>,
    maker_id: String,
) -> Result<Vec<MakerSwapReportSummary>, AppError> {
    let path = resolve_report_path(&state, &maker_id)?;
    let file = tauri::async_runtime::spawn_blocking(move || load_report_file(&path))
        .await
        .map_err(AppError::internal)??;

    let mut reports: Vec<_> = file
        .maker
        .into_values()
        .flatten()
        .map(|r| MakerSwapReportSummary {
            swap_id: r.swap_id,
            status: status_label(&r.status).to_string(),
            start_timestamp: r.start_timestamp,
            end_timestamp: r.end_timestamp,
            incoming_amount_sats: r.incoming_amount,
            outgoing_amount_sats: r.outgoing_amount,
            fee_earned_sats: r.fee_earned,
        })
        .collect();
    reports.sort_by(|a, b| {
        b.start_timestamp
            .cmp(&a.start_timestamp)
            .then_with(|| a.swap_id.cmp(&b.swap_id))
    });
    Ok(reports)
}

#[tauri::command]
pub async fn get_maker_swap_report(
    state: tauri::State<'_, AppState>,
    maker_id: String,
    swap_id: String,
) -> Result<MakerSwapReportDetail, AppError> {
    let path = resolve_report_path(&state, &maker_id)?;
    let file = tauri::async_runtime::spawn_blocking(move || load_report_file(&path))
        .await
        .map_err(AppError::internal)??;

    let r = file
        .maker
        .into_values()
        .flatten()
        .find(|r| r.swap_id == swap_id)
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::ReportNotFound,
                format!("no maker report found for swap_id {swap_id}"),
            )
        })?;

    let deniability_proof = r
        .deniability_proof
        .map(|p| serde_json::to_value(p).unwrap_or(serde_json::Value::Null));

    Ok(MakerSwapReportDetail {
        swap_id: r.swap_id,
        status: status_label(&r.status).to_string(),
        network: r.network,
        swap_duration_seconds: r.swap_duration_seconds,
        start_timestamp: r.start_timestamp,
        end_timestamp: r.end_timestamp,
        incoming_amount_sats: r.incoming_amount,
        outgoing_amount_sats: r.outgoing_amount,
        fee_earned_sats: r.fee_earned,
        incoming_contract_txid: r.incoming_contract_txid,
        outgoing_contract_txid: r.outgoing_contract_txid,
        timelock: r.timelock,
        deniability_proof,
    })
}

#[tauri::command]
pub async fn verify_maker_deniability(
    state: tauri::State<'_, AppState>,
    maker_id: String,
    swap_id: String,
) -> Result<bool, AppError> {
    let server = get_maker_server(&state, &maker_id)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, AppError> {
        Ok(server.verify_deniability(&swap_id)?)
    })
    .await
    .map_err(AppError::internal)?
}
