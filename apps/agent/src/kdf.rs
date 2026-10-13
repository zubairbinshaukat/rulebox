//! Argon2id for the exit PIN and the offline sign-in cache (plan Section 5.9,
//! "Argon2id"). One set of constants for both.
//!
//! A hash that comes from outside the agent (the PIN hash in the desired-state
//! document) is accepted only inside fixed limits, so a hostile document cannot
//! make the agent allocate gigabytes.

use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{Error as HashError, PasswordHasher, PasswordVerifier};
use argon2::{Algorithm, Argon2, Params, Version};

/// Memory in KiB for hashes the agent makes itself.
const MEMORY_KIB: u32 = 19_456;
const PASSES: u32 = 2;
const LANES: u32 = 1;
const OUTPUT_LEN: usize = 32;

/// Limits for a hash that is only verified.
const MEMORY_KIB_RANGE: std::ops::RangeInclusive<u32> = 8_192..=65_536;
const PASSES_RANGE: std::ops::RangeInclusive<u32> = 1..=10;
const LANES_RANGE: std::ops::RangeInclusive<u32> = 1..=4;
/// The PHC string of an Argon2id hash is a few dozen characters; anything
/// longer than this is not one of ours.
const MAX_PHC_LEN: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KdfError {
    /// The hash is not a valid Argon2id hash, or is outside the allowed limits.
    Invalid(String),
    /// Something failed that is not the caller's fault (parameters, RNG).
    Internal(String),
}

impl std::fmt::Display for KdfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(why) => write!(f, "invalid password hash: {why}"),
            Self::Internal(why) => write!(f, "password hashing failed: {why}"),
        }
    }
}

impl std::error::Error for KdfError {}

fn argon2() -> Result<Argon2<'static>, KdfError> {
    let params = Params::new(MEMORY_KIB, PASSES, LANES, Some(OUTPUT_LEN))
        .map_err(|e| KdfError::Internal(e.to_string()))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// Hashes `secret` with a fresh random 16-byte salt; the result is a PHC string.
pub fn hash_secret(secret: &str) -> Result<String, KdfError> {
    let hash = argon2()?
        .hash_password(secret.as_bytes())
        .map_err(|e| KdfError::Internal(e.to_string()))?;
    Ok(hash.to_string())
}

/// True when `secret` matches `phc`. `Err` only for a hash that is invalid or
/// outside the limits (it is never computed in that case).
pub fn verify_secret(secret: &str, phc: &str) -> Result<bool, KdfError> {
    check_hash(phc)?;
    let parsed = parse(phc)?;
    match argon2()?.verify_password(secret.as_bytes(), &parsed) {
        Ok(()) => Ok(true),
        Err(HashError::PasswordInvalid) => Ok(false),
        Err(other) => Err(KdfError::Invalid(other.to_string())),
    }
}

/// The limits above, without hashing anything.
pub fn check_hash(phc: &str) -> Result<(), KdfError> {
    if phc.len() > MAX_PHC_LEN {
        return Err(KdfError::Invalid("too long".into()));
    }
    let parsed = parse(phc)?;
    if parsed.algorithm.as_str() != "argon2id" {
        return Err(KdfError::Invalid("not argon2id".into()));
    }
    if parsed.version != Some(0x13) {
        return Err(KdfError::Invalid("not version 19".into()));
    }
    if parsed.salt.is_none() || parsed.hash.is_none() {
        return Err(KdfError::Invalid("salt or output missing".into()));
    }
    let params = Params::try_from(&parsed).map_err(|e| KdfError::Invalid(e.to_string()))?;
    if !MEMORY_KIB_RANGE.contains(&params.m_cost()) {
        return Err(KdfError::Invalid("memory out of range".into()));
    }
    if !PASSES_RANGE.contains(&params.t_cost()) {
        return Err(KdfError::Invalid("passes out of range".into()));
    }
    if !LANES_RANGE.contains(&params.p_cost()) {
        return Err(KdfError::Invalid("lanes out of range".into()));
    }
    Ok(())
}

fn parse(phc: &str) -> Result<PasswordHash, KdfError> {
    PasswordHash::new(phc).map_err(|e| KdfError::Invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn hash_and_verify_round_trip_within_two_seconds() {
        let started = Instant::now();
        let hash = hash_secret("2468").unwrap();
        assert!(verify_secret("2468", &hash).unwrap());
        // `opt-level = 3` for argon2 and blake2 in the dev profile is what makes this
        // pass; if it fails, that override is not in effect (plan Section 4.4).
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "one hash and one verify took {:?}",
            started.elapsed()
        );
        assert!(!verify_secret("2469", &hash).unwrap());
        assert!(!verify_secret("", &hash).unwrap());
    }

    #[test]
    fn the_hash_is_a_phc_string_with_our_parameters() {
        let hash = hash_secret("pw").unwrap();
        assert!(hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{hash}");
        assert!(check_hash(&hash).is_ok());
    }

    #[test]
    fn two_hashes_of_the_same_secret_differ() {
        assert_ne!(hash_secret("same").unwrap(), hash_secret("same").unwrap());
    }

    #[test]
    fn check_hash_rejects_what_it_must() {
        let good = hash_secret("x").unwrap();
        assert!(check_hash(&good).is_ok());

        // `rest` is "<salt>$<output>".
        let (_, rest) = good.split_once("$m=19456,t=2,p=1$").unwrap();
        let with = |head: &str| format!("{head}${rest}");

        let bad = [
            // argon2i, argon2d
            with("$argon2i$v=19$m=19456,t=2,p=1"),
            with("$argon2d$v=19$m=19456,t=2,p=1"),
            // memory 1 GiB, memory below the floor
            with("$argon2id$v=19$m=1048576,t=2,p=1"),
            with("$argon2id$v=19$m=4096,t=2,p=1"),
            // 11 passes, 0 passes
            with("$argon2id$v=19$m=19456,t=11,p=1"),
            with("$argon2id$v=19$m=19456,t=0,p=1"),
            // 5 lanes
            with("$argon2id$v=19$m=19456,t=2,p=5"),
            // old version
            with("$argon2id$v=16$m=19456,t=2,p=1"),
            // garbage
            "garbage".to_string(),
            String::new(),
            "$argon2id$".to_string(),
            "x".repeat(10_000),
        ];
        for hash in &bad {
            assert!(
                matches!(check_hash(hash), Err(KdfError::Invalid(_))),
                "{hash:.60} should be invalid"
            );
            assert!(matches!(verify_secret("x", hash), Err(KdfError::Invalid(_))));
        }
    }

    #[test]
    fn limits_are_inclusive() {
        let good = hash_secret("x").unwrap();
        let (_, rest) = good.split_once("$m=19456,t=2,p=1$").unwrap();
        for params in ["m=8192,t=1,p=1", "m=65536,t=10,p=4"] {
            let text = format!("$argon2id$v=19${params}${rest}");
            assert!(check_hash(&text).is_ok(), "{text}");
        }
    }

    #[test]
    fn debug_of_the_error_never_contains_the_secret() {
        // The error carries the parser's text about the hash, never the secret.
        let error = verify_secret("s3cr3t-value", "garbage").unwrap_err();
        assert!(!format!("{error:?}{error}").contains("s3cr3t-value"));
    }
}
