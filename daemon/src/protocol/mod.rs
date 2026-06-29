//! murmur wire protocol — framing layer.
//!
//! This is the Rust side of `PROTOCOL.md`. The TypeScript mirror lives in
//! `app/src/protocol`. Keep the two byte-compatible.
//!
//! A [`Frame`] is exactly one GATT write / notification: an 8-byte big-endian
//! header followed by `len` payload bytes. Logical messages larger than one
//! frame are split with the `FRAG_MORE` flag (see [`fragment`]) and rebuilt by
//! [`Reassembler`].

pub mod messages;

use std::collections::HashMap;
use thiserror::Error;

/// Protocol version carried in every frame header.
pub const PROTO_VERSION: u8 = 1;

/// Fixed frame header length in bytes.
pub const HEADER_LEN: usize = 8;

/// `session_id` value used for connection-level frames (auth, credits).
pub const CONNECTION_SESSION: u8 = 0;

/// Frame flag bits.
pub mod flags {
    /// More fragments follow for this logical message.
    pub const FRAG_MORE: u8 = 0x01;
    /// On a `DATA` frame from peripheral→central, marks the bytes as stderr.
    pub const STREAM_ERR: u8 = 0x02;
}

/// Wire opcodes. Values are fixed by `PROTOCOL.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Opcode {
    Hello = 0x01,
    AuthChallenge = 0x02,
    AuthResponse = 0x03,
    AuthOk = 0x04,
    AuthFail = 0x05,
    OpenSession = 0x10,
    SessionOpened = 0x11,
    Data = 0x12,
    Resize = 0x13,
    Signal = 0x14,
    Exec = 0x15,
    ExecResult = 0x16,
    CloseSession = 0x17,
    Credit = 0x20,
    Error = 0x7f,
}

impl Opcode {
    pub fn from_u8(v: u8) -> Result<Self, ProtocolError> {
        use Opcode::*;
        Ok(match v {
            0x01 => Hello,
            0x02 => AuthChallenge,
            0x03 => AuthResponse,
            0x04 => AuthOk,
            0x05 => AuthFail,
            0x10 => OpenSession,
            0x11 => SessionOpened,
            0x12 => Data,
            0x13 => Resize,
            0x14 => Signal,
            0x15 => Exec,
            0x16 => ExecResult,
            0x17 => CloseSession,
            0x20 => Credit,
            0x7f => Error,
            other => return Err(ProtocolError::UnknownOpcode(other)),
        })
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("frame too short: {0} bytes (need at least {HEADER_LEN})")]
    Short(usize),
    #[error("unsupported protocol version {0} (expected {PROTO_VERSION})")]
    Version(u8),
    #[error("unknown opcode 0x{0:02x}")]
    UnknownOpcode(u8),
    #[error("declared payload len {declared} != actual {actual}")]
    LengthMismatch { declared: usize, actual: usize },
    #[error("payload too large for u16 len field: {0} bytes")]
    PayloadTooLarge(usize),
}

/// One protocol frame: header fields plus this fragment's payload bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub opcode: Opcode,
    pub session_id: u8,
    pub flags: u8,
    pub seq: u16,
    pub payload: Vec<u8>,
}

impl Frame {
    /// Maximum payload bytes that fit in a frame given a negotiated ATT MTU.
    pub fn max_payload(mtu: usize) -> usize {
        mtu.saturating_sub(HEADER_LEN)
    }

    pub fn has_more(&self) -> bool {
        self.flags & flags::FRAG_MORE != 0
    }

    /// Serialize to wire bytes (header + payload).
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        if self.payload.len() > u16::MAX as usize {
            return Err(ProtocolError::PayloadTooLarge(self.payload.len()));
        }
        let mut out = Vec::with_capacity(HEADER_LEN + self.payload.len());
        out.push(PROTO_VERSION);
        out.push(self.opcode as u8);
        out.push(self.session_id);
        out.push(self.flags);
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(&(self.payload.len() as u16).to_be_bytes());
        out.extend_from_slice(&self.payload);
        Ok(out)
    }

    /// Parse one frame from wire bytes.
    pub fn decode(buf: &[u8]) -> Result<Frame, ProtocolError> {
        if buf.len() < HEADER_LEN {
            return Err(ProtocolError::Short(buf.len()));
        }
        let ver = buf[0];
        if ver != PROTO_VERSION {
            return Err(ProtocolError::Version(ver));
        }
        let opcode = Opcode::from_u8(buf[1])?;
        let session_id = buf[2];
        let flags = buf[3];
        let seq = u16::from_be_bytes([buf[4], buf[5]]);
        let len = u16::from_be_bytes([buf[6], buf[7]]) as usize;
        let payload = &buf[HEADER_LEN..];
        if payload.len() != len {
            return Err(ProtocolError::LengthMismatch {
                declared: len,
                actual: payload.len(),
            });
        }
        Ok(Frame {
            opcode,
            session_id,
            flags,
            seq,
            payload: payload.to_vec(),
        })
    }
}

/// Split a logical message into one or more frames no larger than `max_payload`.
///
/// `base_flags` is OR-ed into every fragment (e.g. [`flags::STREAM_ERR`]); the
/// [`flags::FRAG_MORE`] bit is managed here. `seq` is advanced once per frame.
pub fn fragment(
    opcode: Opcode,
    session_id: u8,
    base_flags: u8,
    payload: &[u8],
    max_payload: usize,
    seq: &mut u16,
) -> Vec<Frame> {
    let max_payload = max_payload.max(1);
    let mut frames = Vec::new();
    // An empty payload still produces exactly one (empty) frame.
    let mut chunks: Vec<&[u8]> = payload.chunks(max_payload).collect();
    if chunks.is_empty() {
        chunks.push(&[]);
    }
    let last = chunks.len() - 1;
    for (i, chunk) in chunks.into_iter().enumerate() {
        let mut flags = base_flags & !flags::FRAG_MORE;
        if i != last {
            flags |= flags::FRAG_MORE;
        }
        frames.push(Frame {
            opcode,
            session_id,
            flags,
            seq: *seq,
            payload: chunk.to_vec(),
        });
        *seq = seq.wrapping_add(1);
    }
    frames
}

/// A fully reassembled logical message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub opcode: Opcode,
    pub session_id: u8,
    /// Flags from the final fragment (e.g. [`flags::STREAM_ERR`]).
    pub flags: u8,
    pub payload: Vec<u8>,
}

/// Rebuilds logical [`Message`]s from a stream of [`Frame`]s on one
/// characteristic. Fragments of a message share `opcode`+`session_id` and
/// arrive contiguously, so we accumulate per `(session_id, opcode)` key.
#[derive(Default)]
pub struct Reassembler {
    partial: HashMap<(u8, u8), Vec<u8>>,
}

impl Reassembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one frame. Returns `Some(Message)` when a message completes.
    pub fn push(&mut self, frame: Frame) -> Option<Message> {
        let key = (frame.session_id, frame.opcode as u8);
        if frame.has_more() {
            self.partial
                .entry(key)
                .or_default()
                .extend_from_slice(&frame.payload);
            None
        } else {
            let payload = match self.partial.remove(&key) {
                Some(mut buf) => {
                    buf.extend_from_slice(&frame.payload);
                    buf
                }
                None => frame.payload,
            };
            Some(Message {
                opcode: frame.opcode,
                session_id: frame.session_id,
                flags: frame.flags,
                payload,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(frame: &Frame) -> Frame {
        Frame::decode(&frame.encode().unwrap()).unwrap()
    }

    #[test]
    fn header_layout_is_eight_bytes() {
        let f = Frame {
            opcode: Opcode::Data,
            session_id: 7,
            flags: flags::STREAM_ERR,
            seq: 0x1234,
            payload: b"hi".to_vec(),
        };
        let bytes = f.encode().unwrap();
        assert_eq!(bytes.len(), HEADER_LEN + 2);
        assert_eq!(bytes[0], PROTO_VERSION);
        assert_eq!(bytes[1], Opcode::Data as u8);
        assert_eq!(bytes[2], 7);
        assert_eq!(bytes[3], flags::STREAM_ERR);
        assert_eq!(&bytes[4..6], &0x1234u16.to_be_bytes());
        assert_eq!(&bytes[6..8], &2u16.to_be_bytes());
        assert_eq!(&bytes[8..], b"hi");
    }

    #[test]
    fn encode_decode_round_trip() {
        let f = Frame {
            opcode: Opcode::Exec,
            session_id: 3,
            flags: flags::FRAG_MORE,
            seq: 65535,
            payload: vec![0, 1, 2, 250, 255],
        };
        assert_eq!(rt(&f), f);
    }

    #[test]
    fn decode_rejects_short_and_bad_version() {
        assert_eq!(Frame::decode(&[1, 2, 3]), Err(ProtocolError::Short(3)));
        let mut bytes = Frame {
            opcode: Opcode::Hello,
            session_id: 0,
            flags: 0,
            seq: 0,
            payload: vec![],
        }
        .encode()
        .unwrap();
        bytes[0] = 99;
        assert_eq!(Frame::decode(&bytes), Err(ProtocolError::Version(99)));
    }

    #[test]
    fn decode_rejects_length_mismatch() {
        let mut bytes = Frame {
            opcode: Opcode::Data,
            session_id: 1,
            flags: 0,
            seq: 0,
            payload: b"abc".to_vec(),
        }
        .encode()
        .unwrap();
        bytes.pop(); // drop one payload byte, header still claims 3
        assert_eq!(
            Frame::decode(&bytes),
            Err(ProtocolError::LengthMismatch {
                declared: 3,
                actual: 2
            })
        );
    }

    #[test]
    fn fragment_marks_all_but_last() {
        let mut seq = 0;
        let payload: Vec<u8> = (0..50u8).collect();
        let frames = fragment(Opcode::Data, 2, 0, &payload, 20, &mut seq);
        assert_eq!(frames.len(), 3); // 20 + 20 + 10
        assert!(frames[0].has_more());
        assert!(frames[1].has_more());
        assert!(!frames[2].has_more());
        assert_eq!(frames[0].payload.len(), 20);
        assert_eq!(frames[2].payload.len(), 10);
        assert_eq!(seq, 3);
    }

    #[test]
    fn fragment_empty_payload_is_one_frame() {
        let mut seq = 5;
        let frames = fragment(Opcode::AuthOk, 0, 0, &[], 100, &mut seq);
        assert_eq!(frames.len(), 1);
        assert!(!frames[0].has_more());
        assert!(frames[0].payload.is_empty());
        assert_eq!(seq, 6);
    }

    #[test]
    fn fragment_preserves_base_flags() {
        let mut seq = 0;
        let frames = fragment(Opcode::Data, 1, flags::STREAM_ERR, &[1, 2, 3], 2, &mut seq);
        assert_eq!(frames.len(), 2);
        // STREAM_ERR set on every fragment; FRAG_MORE only on non-last.
        assert_eq!(frames[0].flags, flags::STREAM_ERR | flags::FRAG_MORE);
        assert_eq!(frames[1].flags, flags::STREAM_ERR);
    }

    #[test]
    fn reassembler_rebuilds_fragmented_message() {
        let mut seq = 0;
        let payload: Vec<u8> = (0..100u8).collect();
        let frames = fragment(Opcode::ExecResult, 4, 0, &payload, 16, &mut seq);
        assert!(frames.len() > 1);
        let mut re = Reassembler::new();
        let mut out = None;
        for f in frames {
            if let Some(m) = re.push(f) {
                out = Some(m);
            }
        }
        let msg = out.expect("message should complete");
        assert_eq!(msg.opcode, Opcode::ExecResult);
        assert_eq!(msg.session_id, 4);
        assert_eq!(msg.payload, payload);
    }

    #[test]
    fn reassembler_single_frame_message() {
        let mut re = Reassembler::new();
        let f = Frame {
            opcode: Opcode::Hello,
            session_id: 0,
            flags: 0,
            seq: 0,
            payload: b"{}".to_vec(),
        };
        let msg = re.push(f).unwrap();
        assert_eq!(msg.opcode, Opcode::Hello);
        assert_eq!(msg.payload, b"{}");
    }

    #[test]
    fn fragmentation_round_trips_through_mtu() {
        // Simulate the smallest realistic MTU and confirm a large payload
        // survives fragment -> encode -> decode -> reassemble.
        let mtu = 23;
        let max = Frame::max_payload(mtu);
        let original: Vec<u8> = (0..255u8).cycle().take(1000).collect();
        let mut seq = 0;
        let frames = fragment(Opcode::Data, 9, 0, &original, max, &mut seq);
        let mut re = Reassembler::new();
        let mut rebuilt = None;
        for f in frames {
            let bytes = f.encode().unwrap();
            assert!(bytes.len() <= mtu);
            let decoded = Frame::decode(&bytes).unwrap();
            if let Some(m) = re.push(decoded) {
                rebuilt = Some(m.payload);
            }
        }
        assert_eq!(rebuilt.unwrap(), original);
    }
}
