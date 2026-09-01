mod commands;
mod error;
mod logging;
mod security;
mod state;
mod tor;
mod types;

use commands::{
    chain_backend, logs, maker, maker_reports, maker_settings, maker_wallet, market, setup,
    shutdown, taker_reports, taker_swap, taker_wallet,
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

/// Label of the window declared in `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Closing the window only hides it, so a launch while an earlier instance is still alive
    // would otherwise leave two of everything — two Tor instances, two trays, two makers
    // fighting over the same ports. The second launch surfaces the first instead.
    //
    // Release only, and the whole plugin rather than just its callback: the second process
    // exits either way, so in development this would hand `tauri dev` back the *old* running
    // binary and silently discard the rebuild, making every fix look like it did nothing.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            // setup / connectivity
            setup::check_tor,
            setup::get_version_info,
            // chain backend selection
            chain_backend::get_chain_backend,
            chain_backend::set_chain_backend,
            chain_backend::check_backend,
            // taker wallet lifecycle
            taker_wallet::is_wallet_encrypted,
            taker_wallet::list_wallets,
            taker_wallet::init_taker,
            taker_wallet::shutdown_taker,
            taker_wallet::get_wallet_info,
            taker_wallet::choose_restore_backup,
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
            maker_wallet::sync_maker_wallet,
            maker_wallet::list_maker_fidelity_bonds,
            // maker settings (persisted, non-secret config)
            maker_settings::list_makers,
            maker_settings::get_saved_maker_settings,
            maker_settings::list_dashboard_imports,
            maker_settings::import_dashboard_makers,
            maker_settings::clear_maker_settings,
            maker_settings::get_suggested_maker_ports,
            maker_settings::check_maker_ports,
            // maker logs
            logs::get_maker_logs,
            // app lifecycle
            shutdown::quit_app,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing the UI must not tear down a running swap or an active maker,
                // so the window is hidden instead of destroyed. Quitting is explicit:
                // the tray menu, the app menu, or Cmd+Q.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            // Earlier versions persisted the backend, RPC password included. Ceasing to
            // write it is not enough — the old file has to go.
            chain_backend::remove_legacy_config();

            // Tor first, before any wallet or maker exists: everything downstream binds to
            // its ports, and a cold start needs ~45s that overlaps the user picking a wallet.
            std::thread::spawn(|| {
                if let Err(e) = tor::ensure_tor() {
                    log::error!("Portal's Tor failed to start: {e}");
                }
            });

            // Replaces the predefined Quit, whose native terminate lands in `RunEvent::Exit`
            // already inside the OS termination watchdog — too late to stop a maker's closing
            // wallet sync properly. Tauri builds the macOS app submenu first with Quit last.
            let menu = Menu::default(app.handle())?;
            let app_quit =
                MenuItem::with_id(app, "quit", "Quit Portal", true, Some("CmdOrCtrl+Q"))?;
            #[cfg(target_os = "macos")]
            if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu()) {
                if let Some(predefined_quit) = app_menu.items()?.last() {
                    app_menu.remove(predefined_quit)?;
                }
                app_menu.append(&app_quit)?;
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id.as_ref() == "quit" {
                    shutdown::begin_quit(app);
                }
            });

            let open = MenuItem::with_id(app, "open", "Open Portal", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "tray-quit", "Quit Portal", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Portal")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "tray-quit" => shutdown::begin_quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            // `code: None` means the last window went away, which here is not a quit
            // request — the tray keeps the app reachable with no window open.
            RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            RunEvent::Exit => shutdown::shutdown_on_exit(app),
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => show_main_window(app),
            _ => {}
        });
}
