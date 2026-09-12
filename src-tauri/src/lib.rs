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
use std::fs;
use std::path::Path;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

/// Label of the window declared in `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";

/// Upstream renamed its data dir from `~/.coinswap` to `~/.openswap` (PR #988) without shipping
/// a migration, so an updated build starts against an empty directory and every existing wallet,
/// swap tracker and Tor identity looks lost. Copied rather than moved, so an older build still
/// finds its own data.
///
/// The new root existing is not proof the move already happened — Tor writes `tor-manager/` under
/// it the moment the app launches, and a build run before this migration existed leaves one
/// behind — so the marker records that instead, and only entries with nothing in their way are
/// filled in.
fn migrate_legacy_data_dir() {
    let Ok(taker_dir) = openswap::utill::get_taker_dir() else {
        return;
    };
    let Some(root) = taker_dir.parent() else {
        return;
    };
    let Some(legacy_root) = root.parent().map(|home| home.join(".coinswap")) else {
        return;
    };
    let marker = root.join(".migrated-from-coinswap");
    if marker.exists() || !legacy_root.is_dir() {
        return;
    }
    if let Err(e) = merge_dir(&legacy_root, root) {
        // Deliberately no marker on failure, so the next launch tries the rest again rather
        // than leaving the wallets stranded in a directory nothing reads any more.
        log::error!(
            "migrating {} to {}: {e}",
            legacy_root.display(),
            root.display()
        );
        return;
    }
    let _ = fs::write(&marker, "");
}

/// Copies everything under `from` that `to` does not already have, recursing into directories
/// present in both. Never overwrites: anything already in the new tree is the newer copy.
///
/// Directory modes are carried over rather than left to `create_dir_all`: Tor refuses to start
/// when its data directory is group- or world-readable, and the process umask would widen it.
fn merge_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    if !to.exists() {
        fs::create_dir_all(to)?;
        fs::set_permissions(to, from.metadata()?.permissions())?;
    }
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            merge_dir(&entry.path(), &target)?;
        } else if !target.exists() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

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
            setup::restart_tor_bootstrap,
            // chain backend selection
            chain_backend::get_chain_backend,
            chain_backend::set_chain_backend,
            chain_backend::check_backend,
            // taker wallet lifecycle
            taker_wallet::list_wallets,
            taker_wallet::init_taker,
            taker_wallet::get_wallet_info,
            taker_wallet::choose_restore_backup,
            taker_wallet::restore_wallet,
            taker_wallet::backup_wallet,
            // taker wallet operations
            taker_wallet::get_balances,
            taker_wallet::validate_address,
            taker_wallet::get_new_address,
            taker_wallet::verify_last_address,
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
            taker_swap::get_swap_preparation,
            taker_swap::recover_swap,
            taker_swap::get_recovery_status,
            taker_swap::list_recoveries,
            // taker reports
            taker_reports::list_swap_reports,
            taker_reports::get_swap_report,
            taker_reports::get_incoming_swap_utxo,
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
            // Ahead of everything else: Tor, the wallet and the config cleanup below all
            // resolve paths under the data dir, and Tor in particular creates part of it.
            migrate_legacy_data_dir();

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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::Path;

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// The real shape this has to survive: Tor creates `taker/tor-manager/` under the new root
    /// on launch, so the destination already exists before any wallet has been moved into it.
    #[test]
    fn merge_fills_in_what_the_new_tree_is_missing_without_overwriting() {
        let tmp = std::env::temp_dir().join(format!("portal-merge-{}", std::process::id()));
        let (old, new) = (tmp.join("old"), tmp.join("new"));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(old.join("taker/wallets")).unwrap();
        std::fs::create_dir_all(old.join("taker/tor-manager")).unwrap();
        std::fs::create_dir_all(new.join("taker/tor-manager")).unwrap();
        std::fs::write(old.join("taker/wallets/Potterverse"), "wallet").unwrap();
        std::fs::write(old.join("taker/swap_tracker.cbor"), "tracker").unwrap();
        std::fs::write(old.join("taker/tor-manager/tor.log"), "stale").unwrap();
        std::fs::write(new.join("taker/tor-manager/tor.log"), "current").unwrap();

        super::merge_dir(&old, &new).unwrap();

        assert_eq!(read(&new.join("taker/wallets/Potterverse")), "wallet");
        assert_eq!(read(&new.join("taker/swap_tracker.cbor")), "tracker");
        // This session's own Tor log must not be replaced by the old tree's stale one.
        assert_eq!(read(&new.join("taker/tor-manager/tor.log")), "current");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
        text.split_once(start)
            .and_then(|(_, rest)| rest.split_once(end))
            .map(|(body, _)| body)
            .unwrap_or_else(|| panic!("{start} … {end} not found"))
    }

    /// The `command` half of every `module::command` path, ignoring comment lines — the bodies
    /// being scanned carry prose that would otherwise parse as command names.
    fn registered(body: &str) -> BTreeSet<String> {
        let ident = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        body.lines()
            .map(|line| line.trim())
            .filter(|line| !line.starts_with("//"))
            .flat_map(|line| line.split(',').map(str::trim).collect::<Vec<_>>())
            .filter_map(|token| token.split_once("::"))
            .map(|(_, command)| command.trim().to_string())
            .filter(|command| ident(command))
            .collect()
    }

    /// Three hand-maintained lists have to name the same commands: `build.rs` generates one
    /// permission per entry, `generate_handler!` registers the implementations, and the
    /// capability grants them. A command missing from `build.rs` has no permission for the
    /// capability to grant, and one missing from the capability is rejected at the IPC
    /// boundary before it reaches Rust — surfacing in the UI as whatever the caller's `catch`
    /// happens to say. Both drift silently past the compiler, so they are asserted here.
    #[test]
    fn command_permissions_match_registered_commands() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));

        let lib = read(&root.join("src/lib.rs"));
        let handler = registered(between(&lib, "tauri::generate_handler![", "])"));
        assert!(handler.len() > 50, "parsed too few commands: {handler:?}");

        let build = read(&root.join("build.rs"));
        let generated: BTreeSet<String> = between(&build, "const COMMANDS: &[&str] = &[", "];")
            .split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect();
        assert_eq!(
            handler, generated,
            "build.rs COMMANDS and generate_handler! disagree"
        );

        let capability = read(&root.join("capabilities/default.json"));
        let missing: Vec<String> = handler
            .iter()
            .map(|c| format!("allow-{}", c.replace('_', "-")))
            .filter(|p| !capability.contains(&format!("\"{p}\"")))
            .collect();
        assert!(missing.is_empty(), "capability is missing: {missing:?}");
    }
}
