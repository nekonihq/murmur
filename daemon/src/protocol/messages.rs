//! Typed payloads for structured opcodes (everything except raw `DATA`).
//!
//! These are the JSON shapes from `PROTOCOL.md`. `DATA` payloads are raw bytes
//! and are handled directly by the session layer, not here.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hello {
    pub proto: u8,
    #[serde(default)]
    pub client: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthChallenge {
    /// base64-encoded 32-byte nonce.
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthResponse {
    /// base64-encoded HMAC-SHA256(psk, nonce).
    pub mac: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthFail {
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    Pty,
    Exec,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenSession {
    pub session_id: u8,
    pub mode: SessionMode,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionOpened {
    pub session_id: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Resize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Signal {
    Int,
    Term,
    Hup,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Exec {
    pub cmd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloseSession {
    pub session_id: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Credit {
    pub session_id: u8,
    pub n: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorMsg {
    pub code: String,
    pub msg: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_session_uses_defaults() {
        let m: OpenSession = serde_json::from_str(r#"{"session_id":1,"mode":"pty"}"#).unwrap();
        assert_eq!(m.mode, SessionMode::Pty);
        assert_eq!(m.cols, 80);
        assert_eq!(m.rows, 24);
    }

    #[test]
    fn exec_round_trips() {
        let e = Exec {
            cmd: "uname -r".into(),
            timeout_ms: Some(5000),
        };
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(e, serde_json::from_str(&s).unwrap());
    }

    #[test]
    fn exec_omits_null_timeout() {
        let e = Exec {
            cmd: "ls".into(),
            timeout_ms: None,
        };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"cmd":"ls"}"#);
    }

    #[test]
    fn signal_serializes_uppercase() {
        assert_eq!(serde_json::to_string(&Signal::Int).unwrap(), r#""INT""#);
    }
}
