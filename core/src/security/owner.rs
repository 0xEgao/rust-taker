//! The owner password: the credential that lets someone reach Portal at all, on the web server
//! and in the desktop app alike. One per data root, so on a machine running both, it is the same
//! password in both.
//!
//! Separate from every wallet password, always. Unlocking a wallet proves you can spend; this
//! proves you may use the app, and conflating them would put a wallet passphrase on the path of
//! every request.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

/// Temporary, not a permanent lockout: someone who can reach the sign-in screen should not be
/// able to lock the owner out of their own wallet.
const LOGIN_BACKOFF: Duration = Duration::from_secs(30);
/// Per client, so someone guessing only ever locks themselves out.
const MAX_ATTEMPTS: u32 = 10;
/// Across every client: bounds guessing spread over many addresses. Well above what one client
/// can spend, so a single guesser never trips it for everyone.
const MAX_ATTEMPTS_TOTAL: u32 = 100;
/// Clients tracked at once. A spray of addresses evicts the oldest windows rather than growing
/// the map without bound.
const MAX_TRACKED_CLIENTS: usize = 1024;
/// How long a successful sign-in exempts that client from the total cap. Otherwise a handful of
/// addresses spending the whole budget would shut the owner out along with everyone else.
const TRUSTED_FOR: Duration = Duration::from_secs(24 * 60 * 60);

/// Where a claim stores the verifier under a data root.
pub fn owner_file(root: &Path) -> PathBuf {
    root.join("portal").join("auth").join("owner")
}

#[derive(Debug, Default)]
struct Attempts {
    count: u32,
    first: Option<Instant>,
}

impl Attempts {
    fn expired(&self, now: Instant) -> bool {
        self.first.is_some_and(|first| now.duration_since(first) > LOGIN_BACKOFF)
    }

    fn count(&mut self, now: Instant) {
        self.first.get_or_insert(now);
        self.count += 1;
    }
}

#[derive(Debug, Default)]
struct Throttle {
    per_client: HashMap<String, Attempts>,
    total: Attempts,
    /// Clients that signed in, and when.
    trusted: HashMap<String, Instant>,
}

fn read_verifier(path: Option<&Path>) -> Option<String> {
    path.and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Debug)]
pub struct OwnerCredential {
    /// Where a claimed owner's verifier is kept. Argon2id output only — never a password.
    store: Option<PathBuf>,
    verifier: Mutex<Option<String>>,
    throttle: Mutex<Throttle>,
}

impl OwnerCredential {
    /// Loads the verifier, from a provisioned file or from where a claim stored it.
    pub fn load(provisioned: Option<&Path>, store: Option<PathBuf>) -> Self {
        // A provisioned credential file wins: the deployment set it deliberately, and a stale
        // claim on disk must not shadow it.
        let verifier = read_verifier(provisioned).or_else(|| read_verifier(store.as_deref()));
        OwnerCredential {
            store,
            verifier: Mutex::new(verifier),
            throttle: Mutex::new(Throttle::default()),
        }
    }

    /// The verifier, re-read from disk while there is none in memory: another Portal process on
    /// the same data root may have claimed the install since this one started, and trusting the
    /// startup snapshot would refuse the real password and accept a second claim over it.
    fn verifier(&self) -> Result<MutexGuard<'_, Option<String>>, &'static str> {
        let mut verifier = self.verifier.lock().map_err(|_| "auth state poisoned")?;
        if verifier.is_none() {
            *verifier = read_verifier(self.store.as_deref());
        }
        Ok(verifier)
    }

    pub fn has_owner(&self) -> bool {
        self.verifier().is_ok_and(|v| v.is_some())
    }

    /// Sets the owner password on an install that has none, atomically: two concurrent claims
    /// cannot both succeed, and once an owner exists this is refused for good.
    pub fn claim(&self, new_password: &str) -> Result<(), &'static str> {
        // The real gate: claiming needs no session, so the UI's own check is not in the path
        // when a claim is scripted.
        crate::security::input::validate_password(new_password, "owner password")
            .map_err(|_| "owner password must be at least 8 characters")?;
        let mut verifier = self.verifier()?;
        if verifier.is_some() {
            return Err("this installation already has an owner");
        }
        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(new_password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|_| "could not store credential")?;
        if let Some(path) = &self.store {
            if let Some(parent) = path.parent() {
                crate::security::fs::ensure_private_dir(parent)
                    .map_err(|_| "could not create the credential directory")?;
            }
            crate::security::fs::write_private(path, hash.as_bytes())
                .map_err(|_| "could not persist the credential")?;
        }
        *verifier = Some(hash);
        Ok(())
    }

    /// Checks a password from `client`: whatever identifies the caller to the host, a peer
    /// address on the web and a constant on desktop.
    pub fn verify(&self, password: &str, client: &str) -> Result<(), &'static str> {
        self.reserve_attempt(client)?;
        let stored = self.verifier()?.clone().ok_or("this installation has no owner yet")?;
        let parsed = PasswordHash::new(&stored).map_err(|_| "stored credential is unreadable")?;
        if Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_err()
        {
            // Deliberately identical to every other failure: the message must not say whether
            // an owner exists or what was wrong with the password.
            return Err("login failed");
        }
        if let Ok(mut throttle) = self.throttle.lock() {
            throttle.per_client.remove(client);
            if !throttle.trusted.contains_key(client) && throttle.trusted.len() >= MAX_TRACKED_CLIENTS {
                if let Some(oldest) = throttle
                    .trusted
                    .iter()
                    .min_by_key(|(_, at)| **at)
                    .map(|(key, _)| key.clone())
                {
                    throttle.trusted.remove(&oldest);
                }
            }
            throttle.trusted.insert(client.to_string(), Instant::now());
        }
        Ok(())
    }

    /// Counts the attempt before the password is checked, under one lock with the limit check:
    /// counting only failures, after a slow hash, let parallel requests all pass the check
    /// before any of them was recorded.
    fn reserve_attempt(&self, client: &str) -> Result<(), &'static str> {
        let mut throttle = self.throttle.lock().map_err(|_| "auth state poisoned")?;
        let now = Instant::now();
        if throttle.total.expired(now) {
            throttle.total = Attempts::default();
        }
        throttle.per_client.retain(|_, attempts| !attempts.expired(now));
        throttle.trusted.retain(|_, at| now.duration_since(*at) <= TRUSTED_FOR);
        let limited = (throttle.total.count >= MAX_ATTEMPTS_TOTAL
            && !throttle.trusted.contains_key(client))
            || throttle
                .per_client
                .get(client)
                .is_some_and(|attempts| attempts.count >= MAX_ATTEMPTS);
        if limited {
            return Err("too many attempts; try again shortly");
        }
        if !throttle.per_client.contains_key(client) && throttle.per_client.len() >= MAX_TRACKED_CLIENTS {
            if let Some(oldest) = throttle
                .per_client
                .iter()
                .min_by_key(|(_, attempts)| attempts.first)
                .map(|(key, _)| key.clone())
            {
                throttle.per_client.remove(&oldest);
            }
        }
        throttle.total.count(now);
        throttle.per_client.entry(client.to_string()).or_default().count(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trivial_owner_password_is_refused() {
        let owner = OwnerCredential::load(None, None);
        assert!(owner.claim("").is_err());
        assert!(owner.claim("short").is_err());
        assert!(!owner.has_owner(), "a refused claim must not install an owner");
        assert!(owner.claim("long-enough-password").is_ok());
    }

    /// Once claimed, nobody who reaches the sign-in screen later can replace the password.
    #[test]
    fn an_install_is_claimed_once() {
        let owner = OwnerCredential::load(None, None);
        assert!(owner.verify("anything", "a").is_err(), "no owner, nothing to sign in to");
        assert!(owner.claim("new password").is_ok());
        assert!(owner.claim("attacker password").is_err());
        assert!(owner.verify("new password", "a").is_ok());
        assert!(owner.verify("attacker password", "a").is_err());
    }

    /// The desktop app and a web server on one data root: the one that did not take the claim
    /// must still see it.
    #[test]
    fn a_claim_made_by_another_process_is_honoured() {
        let dir = std::env::temp_dir().join(format!("portal-owner-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let here = OwnerCredential::load(None, Some(owner_file(&dir)));
        let other = OwnerCredential::load(None, Some(owner_file(&dir)));
        assert!(other.claim("the real password").is_ok());
        assert!(here.has_owner());
        assert!(here.claim("a second claim").is_err());
        assert!(here.verify("the real password", "a").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repeated_failures_are_throttled_rather_than_locked_out() {
        let owner = OwnerCredential::load(None, None);
        owner.claim("correct horse").unwrap();
        for _ in 0..MAX_ATTEMPTS {
            assert!(owner.verify("wrong", "attacker").is_err());
        }
        assert_eq!(
            owner.verify("correct horse", "attacker").unwrap_err(),
            "too many attempts; try again shortly"
        );
    }

    /// The lockout that mattered: a guesser used to shut the real owner out as well.
    #[test]
    fn one_clients_failures_do_not_lock_out_another() {
        let owner = OwnerCredential::load(None, None);
        owner.claim("correct horse").unwrap();
        for _ in 0..MAX_ATTEMPTS {
            assert!(owner.verify("wrong", "attacker").is_err());
        }
        assert!(owner.verify("correct horse", "owner").is_ok());
    }

    // The budget is spent through `reserve_attempt`, the counter `verify` calls, not through
    // `verify` itself: a hundred Argon2 hashes can outlast the 30s window on a slow runner, and
    // the reset then hides the cap this test is about.
    #[test]
    fn guessing_spread_over_many_clients_hits_the_total_cap() {
        let owner = OwnerCredential::load(None, None);
        owner.claim("correct horse").unwrap();
        for i in 0..MAX_ATTEMPTS_TOTAL {
            assert!(owner.reserve_attempt(&format!("client-{i}")).is_ok());
        }
        assert_eq!(
            owner.verify("wrong", "one-more").unwrap_err(),
            "too many attempts; try again shortly"
        );
    }

    /// Spending the total cap from many addresses must not shut out a client that has already
    /// proven it knows the password.
    #[test]
    fn a_client_that_signed_in_is_exempt_from_the_total_cap() {
        let owner = OwnerCredential::load(None, None);
        owner.claim("correct horse").unwrap();
        owner.verify("correct horse", "owner").unwrap();
        for i in 0..MAX_ATTEMPTS_TOTAL {
            let _ = owner.reserve_attempt(&format!("attacker-{i}"));
        }
        assert_eq!(
            owner.verify("wrong", "stranger").unwrap_err(),
            "too many attempts; try again shortly"
        );
        assert!(owner.verify("correct horse", "owner").is_ok());
    }
}
