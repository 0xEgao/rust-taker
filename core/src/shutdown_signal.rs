//! Termination signals, owned by the host rather than by Tor.
//!
//! libtor starts Tor inside this process, and Tor installs its own `SIGTERM`/`SIGINT` handlers
//! as it comes up. A C handler installed later replaces whatever was there, tokio's included,
//! so once Tor is running the first termination signal reaches Tor alone: it logs "Catching
//! signal TERM, exiting cleanly", exits, and the host never learns it was asked to stop. A
//! supervisor then sees a process that ignored SIGTERM and kills it once the grace period runs
//! out — losing the ordered teardown entirely, which is the one thing that must not happen
//! while a wallet is being written.
//!
//! Re-arming after Tor is up puts the host back in charge. A handler may touch almost nothing
//! safely, so it sets a flag and [`wait`] polls it: shutdown latency is bounded by the poll
//! interval, which costs nothing next to the teardown that follows.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static TRIPPED: AtomicBool = AtomicBool::new(false);

/// Whether a host has taken responsibility for acting on the flag. Claiming these signals
/// without something waiting on [`wait`] would be worse than leaving them alone: the process
/// would stop dying on SIGTERM and nothing would replace that. The desktop host quits through
/// its own window lifecycle and never opts in, so Tor keeps the signals there, exactly as
/// before.
static ADOPTED: AtomicBool = AtomicBool::new(false);

/// Poll interval. Small enough to be invisible against a teardown measured in seconds.
const POLL: Duration = Duration::from_millis(150);

#[cfg(unix)]
extern "C" fn on_signal(_sig: libc::c_int) {
    // The only thing this is allowed to do. No allocation, no logging, no locks.
    TRIPPED.store(true, Ordering::SeqCst);
}

/// Claims `SIGTERM` and `SIGINT` for this process. Only for a host that awaits [`wait`].
#[cfg(unix)]
pub fn arm() {
    ADOPTED.store(true, Ordering::SeqCst);
    install();
}

/// Puts the handler back after something else has overwritten it, but only for a host that
/// claimed the signals in the first place. A no-op everywhere else.
#[cfg(unix)]
pub fn rearm_if_adopted() {
    if ADOPTED.load(Ordering::SeqCst) {
        install();
    }
}

#[cfg(not(unix))]
pub fn rearm_if_adopted() {}

#[cfg(unix)]
fn install() {
    unsafe {
        let handler = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }
}

#[cfg(not(unix))]
pub fn arm() {}

/// True once a termination signal has arrived.
fn tripped() -> bool {
    TRIPPED.load(Ordering::SeqCst)
}

/// Resolves when a termination signal arrives.
pub async fn wait() {
    while !tripped() {
        tokio::time::sleep(POLL).await;
    }
}
