//! Transport-agnostic connection logic: the authentication handshake and the
//! credit-based outbound flow-control pump. Kept independent of BLE so it can be
//! unit-tested on any host; the `ble` module wires raw GATT bytes into these.

use std::collections::{HashMap, VecDeque};

use tracing::warn;

use crate::auth;
use crate::protocol::messages::{AuthChallenge, AuthFail, Hello};
use crate::protocol::{fragment, Frame, Message, Opcode, PROTO_VERSION};
use crate::session::OutEvent;

/// Where a produced frame should be written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// `CTRL` characteristic (auth, credits).
    Ctrl,
    /// `P2C` characteristic (session output).
    P2c,
}

/// State of the per-connection HMAC handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AuthState {
    /// Waiting for `HELLO`.
    AwaitingHello,
    /// Challenge sent; waiting for `AUTH_RESPONSE`. Holds the nonce.
    AwaitingResponse([u8; auth::NONCE_LEN]),
    Authenticated,
    Failed,
}

/// Drives the auth handshake on the `CTRL` characteristic.
pub struct AuthHandler {
    psk: Vec<u8>,
    state: AuthState,
    seq: u16,
}

impl AuthHandler {
    pub fn new(psk: Vec<u8>) -> Self {
        Self {
            psk,
            state: AuthState::AwaitingHello,
            seq: 0,
        }
    }

    pub fn is_authenticated(&self) -> bool {
        self.state == AuthState::Authenticated
    }

    /// Process one decoded `CTRL` message. Returns `CTRL` frames to send back.
    /// On a successful `AUTH_RESPONSE` the state flips to authenticated.
    pub fn handle(&mut self, msg: &Message) -> Vec<Frame> {
        match msg.opcode {
            Opcode::Hello => self.on_hello(&msg.payload),
            Opcode::AuthResponse => self.on_auth_response(&msg.payload),
            _ => Vec::new(),
        }
    }

    fn on_hello(&mut self, payload: &[u8]) -> Vec<Frame> {
        if !matches!(self.state, AuthState::AwaitingHello) {
            return Vec::new();
        }
        // Validate version if HELLO parses; tolerate missing fields.
        if let Ok(hello) = serde_json::from_slice::<Hello>(payload) {
            if hello.proto != PROTO_VERSION {
                self.state = AuthState::Failed;
                return self.frame(
                    Opcode::AuthFail,
                    &AuthFail {
                        reason: format!("unsupported proto {}", hello.proto),
                    },
                );
            }
        }
        let nonce = auth::random_nonce();
        self.state = AuthState::AwaitingResponse(nonce);
        self.frame(
            Opcode::AuthChallenge,
            &AuthChallenge {
                nonce: auth::encode_b64(&nonce),
            },
        )
    }

    fn on_auth_response(&mut self, payload: &[u8]) -> Vec<Frame> {
        let AuthState::AwaitingResponse(nonce) = self.state else {
            return Vec::new();
        };
        let resp: crate::protocol::messages::AuthResponse = match serde_json::from_slice(payload) {
            Ok(r) => r,
            Err(_) => {
                self.state = AuthState::Failed;
                return self.frame(
                    Opcode::AuthFail,
                    &AuthFail {
                        reason: "malformed response".into(),
                    },
                );
            }
        };
        if auth::verify(&self.psk, &nonce, &resp.mac) {
            self.state = AuthState::Authenticated;
            self.frame_empty(Opcode::AuthOk)
        } else {
            self.state = AuthState::Failed;
            warn!("auth failed: bad MAC");
            self.frame(
                Opcode::AuthFail,
                &AuthFail {
                    reason: "bad mac".into(),
                },
            )
        }
    }

    fn frame<T: serde::Serialize>(&mut self, opcode: Opcode, value: &T) -> Vec<Frame> {
        let payload = serde_json::to_vec(value).expect("auth payloads serialize");
        let f = Frame {
            opcode,
            session_id: 0,
            flags: 0,
            seq: self.next_seq(),
            payload,
        };
        vec![f]
    }

    fn frame_empty(&mut self, opcode: Opcode) -> Vec<Frame> {
        vec![Frame {
            opcode,
            session_id: 0,
            flags: 0,
            seq: self.next_seq(),
            payload: Vec::new(),
        }]
    }

    fn next_seq(&mut self) -> u16 {
        let s = self.seq;
        self.seq = self.seq.wrapping_add(1);
        s
    }
}

/// Credit-based outbound pump for the `P2C` direction.
///
/// `DATA` and `EXEC_RESULT` frames are flow-controlled per session: each frame
/// costs one credit, and a message is only released once enough credits exist
/// for all its fragments (fragments must stay contiguous). Control opcodes
/// (`SESSION_OPENED`, `CLOSE_SESSION`, `ERROR`, …) bypass credits.
///
/// MVP limitation: a single FIFO means a credit-starved session can head-of-line
/// block others. Per-session queues are a future refinement.
pub struct OutboundPump {
    max_payload: usize,
    seq: u16,
    credits: HashMap<u8, u32>,
    pending: VecDeque<OutEvent>,
}

impl OutboundPump {
    pub fn new(mtu: usize) -> Self {
        Self {
            max_payload: Frame::max_payload(mtu).max(1),
            seq: 0,
            credits: HashMap::new(),
            pending: VecDeque::new(),
        }
    }

    fn is_flow_controlled(opcode: Opcode) -> bool {
        matches!(opcode, Opcode::Data | Opcode::ExecResult)
    }

    fn frame_count(&self, payload_len: usize) -> usize {
        if payload_len == 0 {
            1
        } else {
            payload_len.div_ceil(self.max_payload)
        }
    }

    /// Grant `n` additional credits to a session and release anything now ready.
    pub fn grant(&mut self, session_id: u8, n: u16) -> Vec<Frame> {
        *self.credits.entry(session_id).or_insert(0) += n as u32;
        self.drain()
    }

    /// Submit an outbound event; returns frames ready to write immediately.
    pub fn submit(&mut self, event: OutEvent) -> Vec<Frame> {
        self.pending.push_back(event);
        self.drain()
    }

    /// Number of events still waiting (for tests / metrics).
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    fn drain(&mut self) -> Vec<Frame> {
        let mut out = Vec::new();
        while let Some(front) = self.pending.front() {
            if Self::is_flow_controlled(front.opcode) {
                let need = self.frame_count(front.payload.len()) as u32;
                let have = self.credits.get(&front.session_id).copied().unwrap_or(0);
                if have < need {
                    break; // not enough credits yet — wait
                }
                *self.credits.get_mut(&front.session_id).unwrap() -= need;
            }
            let event = self.pending.pop_front().unwrap();
            out.extend(fragment(
                event.opcode,
                event.session_id,
                event.flags,
                &event.payload,
                self.max_payload,
                &mut self.seq,
            ));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::messages::AuthResponse;
    use crate::protocol::Reassembler;

    fn decode_one(frames: &[Frame]) -> Message {
        let mut re = Reassembler::new();
        let mut msg = None;
        for f in frames {
            if let Some(m) = re.push(f.clone()) {
                msg = Some(m);
            }
        }
        msg.expect("one complete message")
    }

    #[test]
    fn full_handshake_succeeds() {
        let psk = auth::random_psk();
        let mut h = AuthHandler::new(psk.to_vec());

        let hello = Message {
            opcode: Opcode::Hello,
            session_id: 0,
            flags: 0,
            payload: serde_json::to_vec(&Hello {
                proto: PROTO_VERSION,
                client: "test".into(),
            })
            .unwrap(),
        };
        let challenge_frames = h.handle(&hello);
        let challenge = decode_one(&challenge_frames);
        assert_eq!(challenge.opcode, Opcode::AuthChallenge);
        let ch: AuthChallenge = serde_json::from_slice(&challenge.payload).unwrap();
        let nonce = auth::decode_b64(&ch.nonce).unwrap();

        let mac = auth::encode_b64(&auth::compute_mac(&psk, &nonce));
        let resp = Message {
            opcode: Opcode::AuthResponse,
            session_id: 0,
            flags: 0,
            payload: serde_json::to_vec(&AuthResponse { mac }).unwrap(),
        };
        let ok = decode_one(&h.handle(&resp));
        assert_eq!(ok.opcode, Opcode::AuthOk);
        assert!(h.is_authenticated());
    }

    #[test]
    fn bad_mac_fails_handshake() {
        let mut h = AuthHandler::new(auth::random_psk().to_vec());
        let hello = Message {
            opcode: Opcode::Hello,
            session_id: 0,
            flags: 0,
            payload: b"{\"proto\":1}".to_vec(),
        };
        h.handle(&hello);
        let resp = Message {
            opcode: Opcode::AuthResponse,
            session_id: 0,
            flags: 0,
            payload: serde_json::to_vec(&AuthResponse {
                mac: auth::encode_b64(&[0u8; 32]),
            })
            .unwrap(),
        };
        let fail = decode_one(&h.handle(&resp));
        assert_eq!(fail.opcode, Opcode::AuthFail);
        assert!(!h.is_authenticated());
    }

    #[test]
    fn version_mismatch_rejected() {
        let mut h = AuthHandler::new(auth::random_psk().to_vec());
        let hello = Message {
            opcode: Opcode::Hello,
            session_id: 0,
            flags: 0,
            payload: b"{\"proto\":99}".to_vec(),
        };
        let fail = decode_one(&h.handle(&hello));
        assert_eq!(fail.opcode, Opcode::AuthFail);
    }

    #[test]
    fn control_opcodes_bypass_credits() {
        let mut pump = OutboundPump::new(100);
        // No credits granted, but SESSION_OPENED must still flow.
        let frames = pump.submit(OutEvent {
            session_id: 1,
            opcode: Opcode::SessionOpened,
            flags: 0,
            payload: b"{\"session_id\":1}".to_vec(),
        });
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].opcode, Opcode::SessionOpened);
    }

    #[test]
    fn data_waits_for_credits() {
        let mut pump = OutboundPump::new(100);
        let frames = pump.submit(OutEvent {
            session_id: 1,
            opcode: Opcode::Data,
            flags: 0,
            payload: b"hello".to_vec(),
        });
        assert!(frames.is_empty());
        assert_eq!(pump.pending_len(), 1);

        let released = pump.grant(1, 1);
        assert_eq!(released.len(), 1);
        assert_eq!(released[0].opcode, Opcode::Data);
        assert_eq!(pump.pending_len(), 0);
    }

    #[test]
    fn fragmented_data_needs_credits_for_all_fragments() {
        // mtu 16 -> max_payload 8. 20-byte payload -> 3 frames.
        let mut pump = OutboundPump::new(16);
        let payload = vec![7u8; 20];
        assert!(pump.submit(OutEvent {
            session_id: 2,
            opcode: Opcode::Data,
            flags: 0,
            payload,
        })
        .is_empty());

        // 2 credits is not enough for 3 frames.
        assert!(pump.grant(2, 2).is_empty());
        // One more credit releases the whole message at once.
        let frames = pump.grant(2, 1);
        assert_eq!(frames.len(), 3);
        assert!(frames[0].has_more());
        assert!(!frames[2].has_more());
    }
}
