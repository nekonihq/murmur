"""App-layer authentication: per-connection HMAC challenge/response over a
pre-shared key. Byte-compatible with the Rust/TS sides (standard HMAC-SHA256)."""

from __future__ import annotations

import base64
import hmac
import secrets
from hashlib import sha256

NONCE_LEN = 32
PSK_LEN = 32


def random_psk() -> bytes:
    return secrets.token_bytes(PSK_LEN)


def random_nonce() -> bytes:
    return secrets.token_bytes(NONCE_LEN)


def compute_mac(psk: bytes, nonce: bytes) -> bytes:
    return hmac.new(psk, nonce, sha256).digest()


def verify(psk: bytes, nonce: bytes, mac_b64: str) -> bool:
    try:
        client_mac = base64.b64decode(mac_b64, validate=True)
    except (ValueError, base64.binascii.Error):  # type: ignore[attr-defined]
        return False
    return hmac.compare_digest(client_mac, compute_mac(psk, nonce))


def encode_b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def decode_b64(s: str) -> bytes | None:
    try:
        return base64.b64decode(s, validate=True)
    except Exception:
        return None
