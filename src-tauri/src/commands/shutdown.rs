//! Quit orchestration. Quitting is deliberate — the app menu, Cmd+Q, or the tray — and it
//! tears the process down in dependency order rather than letting the OS drop it:
//! makers, then the taker, then Tor last, because both of the first two route through it.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{maker, taker_wallet};
use crate::error::AppError;
use crate::state::{AppState, SwapLifecycle};
use crate::types::QuitBlockers;

/// Latched by whichever path starts the teardown, so a second Quit while one is already
/// running is ignored and `RunEvent::Exit` does not repeat the work.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Work that a quit would interrupt rather than finish, so the user is asked first.
fn quit_blockers(state: &AppState) -> QuitBlockers {
    let swap_running = state.active_swap.lock().is_ok_and(|swap| {
        swap.as_ref().is_some_and(|swap| {
            matches!(
                swap.phase,
                SwapLifecycle::Running | SwapLifecycle::Recovering
            )
        })
    });
    let running_makers = state
        .makers
        .lock()
        .map(|makers| {
            makers
                .values()
                .filter(|entry| entry.runtime.is_some())
                .map(|entry| entry.settings.maker_id.clone())
                .collect()
        })
        .unwrap_or_default();
    QuitBlockers {
        swap_running,
        running_makers,
    }
}

/// Entry point for every deliberate quit gesture. Asks first when something is mid-flight,
/// otherwise goes straight to teardown.
pub fn begin_quit(app: &AppHandle) {
    let blockers = quit_blockers(&app.state::<AppState>());
    if blockers.swap_running || !blockers.running_makers.is_empty() {
        crate::show_main_window(app);
        let _ = app.emit("app://quit-blocked", blockers);
        return;
    }
    run_quit(app.clone());
}

/// Confirms a quit the user was warned about.
#[tauri::command]
pub fn quit_app(app: AppHandle) -> Result<(), AppError> {
    run_quit(app);
    Ok(())
}

fn run_quit(app: AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    // Shown so the teardown is visible rather than looking like a hung quit; a maker's
    // final wallet sync can run for a while and is deliberately not cut short.
    crate::show_main_window(&app);
    let _ = app.emit("app://quitting", ());
    std::thread::spawn(move || {
        shutdown_runtime(&app);
        app.exit(0);
    });
}

/// Best-effort teardown for the quit paths that cannot be intercepted — the Dock's Quit and
/// an OS logout both land straight in `RunEvent::Exit`, already inside the termination
/// watchdog. `begin_quit` has normally finished by then and this is a no-op.
pub fn shutdown_on_exit(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    shutdown_runtime(app);
}

fn shutdown_runtime(app: &AppHandle) {
    let state = app.state::<AppState>();

    // Makers first: each one finishes its in-flight connections and a closing wallet sync,
    // and all of that traffic is still riding on Tor.
    let _ = app.emit("app://quit-progress", "Stopping makers");
    maker::shutdown_all(&state);

    // Then the taker. Dropping it is the graceful path: the crate's `Drop` flushes the swap
    // tracker and stops the recovery loop and breach detector. A running swap holds the
    // taker mutex for its whole duration, so this cannot take it — the swap's own per-phase
    // writes are what the next launch recovers from.
    let _ = app.emit("app://quit-progress", "Stopping taker");
    if let Err(e) = taker_wallet::shutdown(&state) {
        log::warn!("taker did not shut down cleanly: {e:?}");
    }

    let _ = app.emit("app://quit-progress", "Stopping Tor");
    crate::tor::shutdown();
}
