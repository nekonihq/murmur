"""Transport-agnostic connection logic: the auth handshake and the credit-based
outbound flow-control pump. Independent of BLE so it is unit-testable; the
``ble`` module wires raw GATT bytes into these."""

from __future__ import annotations

import json
import logging
import math
from collections import deque
from typing import TYPE_CHECKING

from . import auth
from .protocol import Frame, Message, Opcode, PROTO_VERSION, SeqCounter, fragment

if TYPE_CHECKING:
    from .session import OutEvent

log = logging.getLogger("murmurd.conn")


class AuthHandler:
    """Drives the per-connection HMAC handshake on the CTRL characteristic."""

    def __init__(self, psk: bytes) -> None:
        self._psk = psk
        self._nonce: bytes | None = None
        self._authenticated = False
        self._failed = False
        self._seq = SeqCounter()

    @property
    def is_authenticated(self) -> bool:
        return self._authenticated

    def handle(self, msg: Message) -> list[Frame]:
        if msg.opcode == Opcode.HELLO:
            return self._on_hello(msg.payload)
        if msg.opcode == Opcode.AUTH_RESPONSE:
            return self._on_auth_response(msg.payload)
        return []

    def _on_hello(self, payload: bytes) -> list[Frame]:
        if self._authenticated or self._failed or self._nonce is not None:
            return []
        try:
            hello = json.loads(payload or b"{}")
            if int(hello.get("proto", PROTO_VERSION)) != PROTO_VERSION:
                self._failed = True
                return self._frame(
                    Opcode.AUTH_FAIL, {"reason": f"unsupported proto {hello.get('proto')}"}
                )
        except (ValueError, TypeError):
            pass  # tolerate a malformed HELLO; still challenge
        self._nonce = auth.random_nonce()
        return self._frame(Opcode.AUTH_CHALLENGE, {"nonce": auth.encode_b64(self._nonce)})

    def _on_auth_response(self, payload: bytes) -> list[Frame]:
        if self._nonce is None or self._authenticated:
            return []
        try:
            resp = json.loads(payload)
            mac = resp["mac"]
        except (ValueError, TypeError, KeyError):
            self._failed = True
            return self._frame(Opcode.AUTH_FAIL, {"reason": "malformed response"})
        if auth.verify(self._psk, self._nonce, mac):
            self._authenticated = True
            return self._frame(Opcode.AUTH_OK, {})
        self._failed = True
        expected = auth.encode_b64(auth.compute_mac(self._psk, self._nonce))
        log.warning(
            "auth failed: bad MAC (psk_len=%d nonce=%s got_mac=%r expected_mac=%s)",
            len(self._psk),
            auth.encode_b64(self._nonce),
            mac,
            expected,
        )
        return self._frame(Opcode.AUTH_FAIL, {"reason": "bad mac"})

    def _frame(self, opcode: Opcode, value: dict) -> list[Frame]:
        payload = json.dumps(value, separators=(",", ":")).encode() if value else b""
        return [Frame(opcode, 0, 0, self._seq.next(), payload)]


# Opcodes whose frames are flow-controlled (peripheral -> central data).
_FLOW_CONTROLLED = {Opcode.DATA, Opcode.EXEC_RESULT}

# Cap outstanding credits per session. The central grants generously (and tops
# up on a timer to survive lost notifications); this bounds the window so
# over-granting can't balloon and flow control still means something.
MAX_CREDITS = 96


class OutboundPump:
    """Credit-based outbound pump for the P2C direction.

    DATA/EXEC_RESULT frames cost one credit each; a message is only released once
    enough credits exist for all its fragments (fragments stay contiguous).
    Control opcodes bypass credits. Single FIFO: a credit-starved session can
    head-of-line block others (MVP; per-session queues are a future refinement).
    """

    def __init__(self, mtu: int) -> None:
        from .protocol import max_payload

        self._max_payload = max(1, max_payload(mtu))
        self._seq = SeqCounter()
        self._credits: dict[int, int] = {}
        self._pending: deque[OutEvent] = deque()

    @property
    def pending_len(self) -> int:
        return len(self._pending)

    def _frame_count(self, payload_len: int) -> int:
        return 1 if payload_len == 0 else math.ceil(payload_len / self._max_payload)

    def grant(self, session_id: int, n: int) -> list[Frame]:
        self._credits[session_id] = min(MAX_CREDITS, self._credits.get(session_id, 0) + n)
        return self._drain()

    def submit(self, event: "OutEvent") -> list[Frame]:
        self._pending.append(event)
        return self._drain()

    def _drain(self) -> list[Frame]:
        out: list[Frame] = []
        while self._pending:
            front = self._pending[0]
            if front.opcode in _FLOW_CONTROLLED:
                need = self._frame_count(len(front.payload))
                have = self._credits.get(front.session_id, 0)
                if have < need:
                    break
                self._credits[front.session_id] = have - need
            event = self._pending.popleft()
            out.extend(
                fragment(
                    event.opcode,
                    event.session_id,
                    event.flags,
                    event.payload,
                    self._max_payload,
                    self._seq,
                )
            )
        return out
