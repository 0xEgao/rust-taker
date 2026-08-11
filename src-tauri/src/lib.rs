mod commands;
mod error;
mod logging;
mod state;
mod tor;
mod types;

use commands::{
    logs, maker, maker_reports, maker_settings, maker_wallet, market, setup, taker_reports,
    taker_swap, taker_wallet,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            // setup / connectivity
            setup::check_port,
            setup::check_electrum,
            setup::check_bitcoin_core,
            setup::check_tor,
            setup::get_version_info,
            // taker wallet lifecycle
            taker_wallet::is_wallet_encrypted,
            taker_wallet::list_wallets,
            taker_wallet::init_taker,
            taker_wallet::shutdown_taker,
            taker_wallet::get_wallet_info,
            taker_wallet::restore_wallet,
            taker_wallet::backup_wallet,
            // taker wallet operations
            taker_wallet::get_balances,
            taker_wallet::check_swap_liquidity,
            taker_wallet::validate_address,
            taker_wallet::get_new_address,
            taker_wallet::get_transactions,
            taker_wallet::list_utxos,
            taker_wallet::send_to_address,
            taker_wallet::sync_wallet,
            taker_wallet::estimate_fees,
            taker_wallet::get_btc_price,
            // market / offerbook
            market::get_offers,
            market::sync_offerbook,
            market::poll_maker,
            market::remove_maker,
            // taker swap
            taker_swap::prepare_swap,
            taker_swap::estimate_swap_funding,
            taker_swap::start_swap,
            taker_swap::get_swap_progress,
            taker_swap::get_swap_tracker,
            taker_swap::recover_swap,
            taker_swap::get_recovery_status,
            // taker reports
            taker_reports::list_swap_reports,
            taker_reports::get_swap_report,
            taker_reports::verify_deniability,
            // taker logs
            logs::get_logs,
            // maker lifecycle
            maker::init_maker,
            maker::update_maker_settings,
            maker::start_maker,
            maker::stop_maker,
            maker::get_maker_status,
            maker::get_maker_info,
            // maker reports
            maker_reports::list_maker_swap_reports,
            maker_reports::get_maker_swap_report,
            maker_reports::verify_maker_deniability,
            // maker's own wallet
            maker_wallet::get_maker_balances,
            maker_wallet::list_maker_utxos,
            maker_wallet::get_maker_new_address,
            maker_wallet::get_maker_transactions,
            maker_wallet::send_from_maker_wallet,
            maker_wallet::sync_maker_wallet,
            maker_wallet::list_maker_fidelity_bonds,
            // maker settings (persisted, non-secret config)
            maker_settings::list_makers,
            maker_settings::get_saved_maker_settings,
            maker_settings::clear_maker_settings,
            maker_settings::get_suggested_maker_ports,
            // maker logs
            logs::get_maker_logs,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state: tauri::State<state::AppState> = window.state();
                // Drop for Taker flushes offerbook/wallet state and stops
                // background threads. Best-effort: the app is closing either way.
                let _ = taker_wallet::shutdown(&state);
                // Every maker runtime is process-local. Stop all of them; registrations and
                // wallets remain on disk and nothing auto-starts on the next launch.
                maker::shutdown_all(&state);
                // Kill any host `tor` process we spawned — it has no other owner to reap it.
                let spawned_tor = state
                    .managed_tor
                    .lock()
                    .ok()
                    .and_then(|mut guard| guard.take());
                if let Some(mut child) = spawned_tor {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
