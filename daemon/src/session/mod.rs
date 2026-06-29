//! Session layer: multiplexes `pty` (shell mode) and `exec` (agent mode)
//! sessions over one connection, turning inbound [`Message`]s into outbound
//! [`OutEvent`]s for the transport to fragment and send.

pub mod exec;
pub mod pty;

use std::collections::HashMap;

use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;
use tracing::{debug, warn};

use crate::protocol::messages::{
    CloseSession, Exec, ExecResult, OpenSession, Resize, SessionMode, SessionOpened, Signal,
};
use crate::protocol::{Message, Opcode};

use pty::PtySession;

/// An outbound logical message produced by a session, before fragmentation. The
/// transport applies flow control, fragments it to the MTU, and writes it on the
/// appropriate characteristic.
#[derive(Debug, Clone)]
pub struct OutEvent {
    pub session_id: u8,
    pub opcode: Opcode,
    pub flags: u8,
    pub payload: Vec<u8>,
}

impl OutEvent {
    /// Build an event whose payload is JSON for a structured opcode.
    pub fn json<T: Serialize>(session_id: u8, opcode: Opcode, value: &T) -> Self {
        let payload = serde_json::to_vec(value).expect("session payloads always serialize");
        Self {
            session_id,
            opcode,
            flags: 0,
            payload,
        }
    }

    /// A `CLOSE_SESSION` event for the given session.
    pub fn close(session_id: u8) -> Self {
        Self::json(
            session_id,
            Opcode::CloseSession,
            &CloseSession { session_id },
        )
    }

    fn error(session_id: u8, code: &str, msg: &str) -> Self {
        Self::json(
            session_id,
            Opcode::Error,
            &crate::protocol::messages::ErrorMsg {
                code: code.into(),
                msg: msg.into(),
            },
        )
    }
}

/// Owns all active sessions for one authenticated connection.
pub struct SessionManager {
    out: UnboundedSender<OutEvent>,
    shell: String,
    ptys: HashMap<u8, PtySession>,
}

impl SessionManager {
    pub fn new(out: UnboundedSender<OutEvent>, shell: String) -> Self {
        Self {
            out,
            shell,
            ptys: HashMap::new(),
        }
    }

    fn emit(&self, event: OutEvent) {
        if self.out.send(event).is_err() {
            warn!("out channel closed; dropping session event");
        }
    }

    /// Dispatch one decoded inbound message. Only post-auth opcodes are handled
    /// here; auth lives in the connection layer.
    pub fn handle(&mut self, msg: Message) {
        match msg.opcode {
            Opcode::OpenSession => self.on_open(&msg.payload),
            Opcode::Data => self.on_data(msg.session_id, &msg.payload),
            Opcode::Resize => self.on_resize(msg.session_id, &msg.payload),
            Opcode::Signal => self.on_signal(msg.session_id, &msg.payload),
            Opcode::Exec => self.on_exec(msg.session_id, &msg.payload),
            Opcode::CloseSession => self.on_close(msg.session_id),
            other => debug!(?other, "ignoring unexpected inbound opcode"),
        }
    }

    fn on_open(&mut self, payload: &[u8]) {
        let req: OpenSession = match serde_json::from_slice(payload) {
            Ok(r) => r,
            Err(e) => {
                self.emit(OutEvent::error(0, "bad_open", &e.to_string()));
                return;
            }
        };
        let id = req.session_id;
        match req.mode {
            SessionMode::Pty => {
                match PtySession::start(id, &self.shell, req.cols, req.rows, self.out.clone()) {
                    Ok(session) => {
                        self.ptys.insert(id, session);
                        self.emit(OutEvent::json(
                            id,
                            Opcode::SessionOpened,
                            &SessionOpened { session_id: id },
                        ));
                    }
                    Err(e) => self.emit(OutEvent::error(id, "pty_start", &e.to_string())),
                }
            }
            SessionMode::Exec => {
                // Exec sessions are stateless: each EXEC spawns a fresh command.
                self.emit(OutEvent::json(
                    id,
                    Opcode::SessionOpened,
                    &SessionOpened { session_id: id },
                ));
            }
        }
    }

    fn on_data(&mut self, session_id: u8, bytes: &[u8]) {
        match self.ptys.get_mut(&session_id) {
            Some(pty) => {
                if let Err(e) = pty.write_stdin(bytes) {
                    self.emit(OutEvent::error(session_id, "stdin", &e.to_string()));
                }
            }
            None => debug!(session_id, "DATA for unknown pty session"),
        }
    }

    fn on_resize(&mut self, session_id: u8, payload: &[u8]) {
        let Ok(req) = serde_json::from_slice::<Resize>(payload) else {
            return;
        };
        if let Some(pty) = self.ptys.get(&session_id) {
            if let Err(e) = pty.resize(req.cols, req.rows) {
                self.emit(OutEvent::error(session_id, "resize", &e.to_string()));
            }
        }
    }

    fn on_signal(&mut self, session_id: u8, payload: &[u8]) {
        let Ok(req) = serde_json::from_slice::<Signal>(payload) else {
            return;
        };
        if let Some(pty) = self.ptys.get_mut(&session_id) {
            if let Err(e) = pty.signal(req) {
                self.emit(OutEvent::error(session_id, "signal", &e.to_string()));
            }
        }
    }

    fn on_exec(&mut self, session_id: u8, payload: &[u8]) {
        let req: Exec = match serde_json::from_slice(payload) {
            Ok(r) => r,
            Err(e) => {
                self.emit(OutEvent::error(session_id, "bad_exec", &e.to_string()));
                return;
            }
        };
        // Run off the dispatch path so the connection stays responsive; deliver
        // the single EXEC_RESULT when the command finishes.
        let out = self.out.clone();
        tokio::spawn(async move {
            let result: ExecResult = exec::run_exec(&req.cmd, req.timeout_ms).await;
            let _ = out.send(OutEvent::json(session_id, Opcode::ExecResult, &result));
        });
    }

    fn on_close(&mut self, session_id: u8) {
        self.ptys.remove(&session_id); // Drop kills the child
    }
}
