// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(unix)]
    unsafe {
        // Apply before Tauri, logging, Tor, or the protocol creates files.
        libc::umask(0o077);
    }
    portal_lib::run()
}
