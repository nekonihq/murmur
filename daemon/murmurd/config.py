"""Daemon configuration and pre-shared-key persistence."""

from __future__ import annotations

import os
from pathlib import Path

from . import auth

PSK_FILE = "psk"


def psk_path(config_dir: Path) -> Path:
    return config_dir / PSK_FILE


def load_or_create_psk(config_dir: Path) -> bytes:
    """Load the PSK, generating and persisting a fresh one (0600) on first run."""
    path = psk_path(config_dir)
    if path.exists():
        psk = auth.decode_b64(path.read_text().strip())
        if psk is None:
            raise ValueError(f"PSK file {path} is not valid base64")
        if len(psk) != auth.PSK_LEN:
            raise ValueError(f"PSK must be {auth.PSK_LEN} bytes, found {len(psk)}")
        return psk
    config_dir.mkdir(parents=True, exist_ok=True)
    psk = auth.random_psk()
    path.write_text(auth.encode_b64(psk))
    os.chmod(path, 0o600)
    return psk


def print_pairing(config_dir: Path) -> None:
    """Print enrollment material for a phone (the base64 PSK for manual entry)."""
    psk = load_or_create_psk(config_dir)
    print("murmur pairing")
    print("--------------")
    print("Enter this key in the murmur app's pairing screen:")
    print()
    print(f"  {auth.encode_b64(psk)}")
    print()
    print("Keep it secret — it grants shell access to this device.")
