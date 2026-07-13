"""murmur wire protocol — framing layer (Python).

Byte-compatible with ``app/src/protocol`` (TypeScript). See ``PROTOCOL.md``.
A :class:`Frame` is one GATT write/notification: an 8-byte
big-endian header followed by ``len`` payload bytes. Logical messages larger
than one frame are split with the ``FRAG_MORE`` flag (:func:`fragment`) and
rebuilt by :class:`Reassembler`.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from enum import IntEnum

PROTO_VERSION = 1
HEADER_LEN = 8
CONNECTION_SESSION = 0

# Frame flag bits.
FRAG_MORE = 0x01
STREAM_ERR = 0x02

# ver, opcode, session_id, flags, seq (u16 BE), len (u16 BE)
_HEADER = struct.Struct(">BBBBHH")


class Opcode(IntEnum):
    HELLO = 0x01
    AUTH_CHALLENGE = 0x02
    AUTH_RESPONSE = 0x03
    AUTH_OK = 0x04
    AUTH_FAIL = 0x05
    OPEN_SESSION = 0x10
    SESSION_OPENED = 0x11
    DATA = 0x12
    RESIZE = 0x13
    SIGNAL = 0x14
    EXEC = 0x15
    EXEC_RESULT = 0x16
    CLOSE_SESSION = 0x17
    CREDIT = 0x20
    ERROR = 0x7F


class ProtocolError(Exception):
    pass


@dataclass
class Frame:
    opcode: Opcode
    session_id: int
    flags: int
    seq: int
    payload: bytes = b""

    @property
    def has_more(self) -> bool:
        return bool(self.flags & FRAG_MORE)

    def encode(self) -> bytes:
        if len(self.payload) > 0xFFFF:
            raise ProtocolError(f"payload too large: {len(self.payload)}")
        return (
            _HEADER.pack(
                PROTO_VERSION,
                int(self.opcode),
                self.session_id & 0xFF,
                self.flags & 0xFF,
                self.seq & 0xFFFF,
                len(self.payload),
            )
            + self.payload
        )

    @classmethod
    def decode(cls, buf: bytes) -> "Frame":
        if len(buf) < HEADER_LEN:
            raise ProtocolError(f"frame too short: {len(buf)}")
        ver, opcode, session_id, flags, seq, length = _HEADER.unpack(buf[:HEADER_LEN])
        if ver != PROTO_VERSION:
            raise ProtocolError(f"unsupported version {ver}")
        try:
            op = Opcode(opcode)
        except ValueError as e:
            raise ProtocolError(f"unknown opcode 0x{opcode:02x}") from e
        payload = buf[HEADER_LEN:]
        if len(payload) != length:
            raise ProtocolError(f"declared len {length} != actual {len(payload)}")
        return cls(op, session_id, flags, seq, payload)


def max_payload(mtu: int) -> int:
    return max(0, mtu - HEADER_LEN)


@dataclass
class SeqCounter:
    """Mutable sequence counter shared across :func:`fragment` calls."""

    value: int = 0

    def next(self) -> int:
        s = self.value
        self.value = (self.value + 1) & 0xFFFF
        return s


def fragment(
    opcode: Opcode,
    session_id: int,
    base_flags: int,
    payload: bytes,
    max_payload_size: int,
    seq: SeqCounter,
) -> list[Frame]:
    """Split a logical message into frames no larger than ``max_payload_size``.

    ``base_flags`` is OR-ed into every fragment; ``FRAG_MORE`` is managed here.
    An empty payload still yields exactly one (empty) frame.
    """
    chunk = max(1, max_payload_size)
    chunks = [payload[i : i + chunk] for i in range(0, len(payload), chunk)] or [b""]
    last = len(chunks) - 1
    frames: list[Frame] = []
    for i, data in enumerate(chunks):
        flags = base_flags & ~FRAG_MORE
        if i != last:
            flags |= FRAG_MORE
        frames.append(Frame(opcode, session_id, flags, seq.next(), data))
    return frames


@dataclass
class Message:
    opcode: Opcode
    session_id: int
    flags: int
    payload: bytes


@dataclass
class Reassembler:
    """Rebuilds logical :class:`Message`s from frames on one characteristic.

    Accumulates per ``(session_id, opcode)`` key, mirroring the TS side. Detects
    a gap in the per-direction sequence (a lost frame) and drops any in-progress
    reassembly to resync, so one lost fragment can't corrupt later messages.
    """

    _partial: dict[tuple[int, int], bytearray] = field(default_factory=dict)
    _last_seq: int | None = None

    def push(self, frame: Frame) -> Message | None:
        if self._last_seq is not None and frame.seq != (self._last_seq + 1) % 0x10000:
            self._partial.clear()
        self._last_seq = frame.seq

        key = (frame.session_id, int(frame.opcode))
        if frame.has_more:
            self._partial.setdefault(key, bytearray()).extend(frame.payload)
            return None
        buffered = self._partial.pop(key, None)
        if buffered is not None:
            buffered.extend(frame.payload)
            payload = bytes(buffered)
        else:
            payload = frame.payload
        return Message(frame.opcode, frame.session_id, frame.flags, payload)
