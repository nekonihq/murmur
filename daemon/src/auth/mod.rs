//! App-layer authentication: per-connection HMAC challenge/response over a
//! pre-shared key. See `PROTOCOL.md` § Authentication.

use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

pub const NONCE_LEN: usize = 32;
pub const PSK_LEN: usize = 32;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Generate a fresh random pre-shared key (used once during pairing).
pub fn random_psk() -> [u8; PSK_LEN] {
    let mut psk = [0u8; PSK_LEN];
    rand::thread_rng().fill_bytes(&mut psk);
    psk
}

/// Generate a fresh per-connection challenge nonce.
pub fn random_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    nonce
}

/// HMAC-SHA256(psk, nonce). Both sides compute this; the response carries the
/// base64 of it.
pub fn compute_mac(psk: &[u8], nonce: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(psk).expect("HMAC accepts any key length");
    mac.update(nonce);
    mac.finalize().into_bytes().to_vec()
}

/// Verify a base64 client MAC against `HMAC-SHA256(psk, nonce)` in constant time.
pub fn verify(psk: &[u8], nonce: &[u8], mac_b64: &str) -> bool {
    let Ok(client_mac) = B64.decode(mac_b64) else {
        return false;
    };
    let expected = compute_mac(psk, nonce);
    // ConstantTimeEq over equal-length slices; length check first is fine since
    // the digest length is fixed and public.
    if client_mac.len() != expected.len() {
        return false;
    }
    client_mac.ct_eq(&expected).into()
}

pub fn encode_b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn decode_b64(s: &str) -> Option<Vec<u8>> {
    B64.decode(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correct_mac_verifies() {
        let psk = random_psk();
        let nonce = random_nonce();
        let mac = encode_b64(&compute_mac(&psk, &nonce));
        assert!(verify(&psk, &nonce, &mac));
    }

    #[test]
    fn wrong_psk_rejected() {
        let nonce = random_nonce();
        let mac = encode_b64(&compute_mac(&random_psk(), &nonce));
        assert!(!verify(&random_psk(), &nonce, &mac));
    }

    #[test]
    fn wrong_nonce_rejected() {
        let psk = random_psk();
        let mac = encode_b64(&compute_mac(&psk, &random_nonce()));
        assert!(!verify(&psk, &random_nonce(), &mac));
    }

    #[test]
    fn garbage_mac_rejected() {
        let psk = random_psk();
        let nonce = random_nonce();
        assert!(!verify(&psk, &nonce, "not base64!!!"));
        assert!(!verify(&psk, &nonce, ""));
    }
}
