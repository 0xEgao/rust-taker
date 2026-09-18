//! Termination signals, owned by the host rather than by Tor.
//!
//! libtor runs Tor inside this process, and once it is up Tor gets the signal no matter what
//! the host does. Two approaches were tried and measured against a running Tor, and neither
//! works: masking the signals is worse than useless, because a process-directed signal goes
//! to any thread that has not blocked it and Tor unblocks them in its own — so a mask simply
//! guarantees Tor receives it. Reinstalling the disposition afterwards does not win either,
//! because libevent watches signals through kqueue, which the disposition does not govern.
//!
//! So the host stops fighting for the signal and uses two facts instead:
//!
//! - [`arm`] installs a handler, which is what catches a signal arriving before Tor exists.
//! - [`trip_if_adopted`] covers every moment after that. Reinstalling the handler was tried
//!   and measured: it runs, and Tor still receives the signal, because libevent watches for
//!   signals through kqueue rather than the disposition. So once Tor is running it always
//!   takes the signal and exits — and an exit nobody asked for is itself the notification.
//!   A Tor that died on its own is equally terminal: `tor_main` cannot run twice here.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static TRIPPED: AtomicBool = AtomicBool::new(false);

/// Whether a host has taken responsibility for acting on the flag. Claiming these signals
/// without something waiting on [`wait`] would be worse than leaving them alone: the process
/// would stop dying on SIGTERM and nothing would replace that. The desktop host quits through
/// its own window lifecycle and never opts in, so signals there behave as the platform
/// intends and Tor's exit does not end the app.
static ADOPTED: AtomicBool = AtomicBool::new(false);

/// Poll interval for [`wait`]. Invisible against a teardown measured in seconds.
const POLL: Duration = Duration::from_millis(150);

#[cfg(unix)]
extern "C" fn on_signal(_sig: libc::c_int) {
    // The only thing a handler is allowed to do. No allocation, no logging, no locks.
    TRIPPED.store(true, Ordering::SeqCst);
}

/// Claims `SIGTERM` and `SIGINT`. Only for a host that awaits [`wait`].
#[cfg(unix)]
pub fn arm() {
    ADOPTED.store(true, Ordering::SeqCst);
    install();
}

#[cfg(not(unix))]
pub fn arm() {
    ADOPTED.store(true, Ordering::SeqCst);
}

/// Reports a termination that arrived some way other than a signal we caught.
pub fn trip_if_adopted() {
    if ADOPTED.load(Ordering::SeqCst) {
        TRIPPED.store(true, Ordering::SeqCst);
    }
}

#[cfg(unix)]
fn install() {
    unsafe {
        let handler = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }
}

/// Resolves when the process has been asked to stop.
#[cfg(unix)]
pub async fn wait() {
    while !TRIPPED.load(Ordering::SeqCst) {
        tokio::time::sleep(POLL).await;
    }
}

/// No POSIX signals to take, so nothing would ever set the flag; fall back to the runtime's.
#[cfg(not(unix))]
pub async fn wait() {
    let _ = tokio::signal::ctrl_c().await;
}
