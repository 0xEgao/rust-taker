//! Tail of each role's `debug.log`, written by our own dual-role logger
//! (see `logging.rs`, wired up in `commands::taker_wallet::init_taker` /
//! `commands::maker::init_maker`). One function per role, not worth two
//! files for — both are a three-line tail against a different `AppState`
//! field.

use crate::error::AppError;
use crate::state::AppState;
use crate::types::LogLine;

#[tauri::command]
pub async fn get_logs(
    state: tauri::State<'_, AppState>,
    lines: Option<usize>,
) -> Result<Vec<LogLine>, AppError> {
    let data_dir = state
        .data_dir
        .read()?
        .clone()
        .ok_or_else(AppError::not_initialized)?;
    let path = data_dir.join("debug.log");
    let want = lines.unwrap_or(100);

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<LogLine>, AppError> {
        Ok(crate::logging::tail_lines(&path, want)?
            .into_iter()
            .map(|line| LogLine { line })
            .collect())
    })
    .await
    .map_err(AppError::internal)?
}

#[tauri::command]
pub async fn get_maker_logs(
    state: tauri::State<'_, AppState>,
    maker_id: String,
    lines: Option<usize>,
) -> Result<Vec<LogLine>, AppError> {
    let data_dir = {
        let makers = state.makers.lock()?;
        let in_memory = makers.get(&maker_id).map(|entry| entry.settings.clone());
        drop(makers);
        let settings = match in_memory {
            Some(settings) => settings,
            None => crate::commands::maker_settings::load(&maker_id)?
                .ok_or_else(|| AppError::maker_not_found(&maker_id))?,
        };
        settings
            .data_dir
            .as_deref()
            .map(std::path::PathBuf::from)
            .ok_or_else(AppError::maker_not_initialized)?
    };
    let path = data_dir.join("debug.log");
    let want = lines.unwrap_or(100);

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<LogLine>, AppError> {
        Ok(crate::logging::tail_lines(&path, want)?
            .into_iter()
            .map(|line| LogLine { line })
            .collect())
    })
    .await
    .map_err(AppError::internal)?
}
