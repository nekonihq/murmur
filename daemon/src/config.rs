//! Daemon configuration and pre-shared-key persistence.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::auth;

/// Filename holding the base64 pre-shared key inside the config dir.
const PSK_FILE: &str = "psk";

pub fn psk_path(config_dir: &Path) -> PathBuf {
    config_dir.join(PSK_FILE)
}

/// Load the PSK from `<config_dir>/psk`, generating and persisting a fresh one
/// (0600) on first run.
pub fn load_or_create_psk(config_dir: &Path) -> Result<Vec<u8>> {
    let path = psk_path(config_dir);
    if path.exists() {
        let b64 = fs::read_to_string(&path)
            .with_context(|| format!("reading PSK from {}", path.display()))?;
        let psk = auth::decode_b64(b64.trim()).context("PSK file is not valid base64")?;
        anyhow::ensure!(
            psk.len() == auth::PSK_LEN,
            "PSK must be {} bytes, found {}",
            auth::PSK_LEN,
            psk.len()
        );
        Ok(psk)
    } else {
        fs::create_dir_all(config_dir)
            .with_context(|| format!("creating config dir {}", config_dir.display()))?;
        let psk = auth::random_psk();
        fs::write(&path, auth::encode_b64(&psk))
            .with_context(|| format!("writing PSK to {}", path.display()))?;
        restrict_permissions(&path)?;
        Ok(psk.to_vec())
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("setting 0600 on {}", path.display()))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

/// Print enrollment material for a phone. MVP: show the PSK as base64 for manual
/// entry (a QR code can wrap the same value later). The runtime challenge/
/// response (`PROTOCOL.md` § Authentication) is the stable contract.
pub fn print_pairing(config_dir: &Path) -> Result<()> {
    let psk = load_or_create_psk(config_dir)?;
    println!("murmur pairing");
    println!("--------------");
    println!("Enter this key in the murmur app's pairing screen:");
    println!();
    println!("  {}", auth::encode_b64(&psk));
    println!();
    println!("Keep it secret — it grants shell access to this device.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn psk_persists_across_loads() {
        let dir = std::env::temp_dir().join(format!("murmur-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let first = load_or_create_psk(&dir).unwrap();
        let second = load_or_create_psk(&dir).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), auth::PSK_LEN);
        let _ = fs::remove_dir_all(&dir);
    }
}
