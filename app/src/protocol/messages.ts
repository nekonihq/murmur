// Typed payloads for structured opcodes — TS mirror of
// `daemon/src/protocol/messages.rs`. `DATA` payloads are raw bytes (not here).

export interface Hello {
  proto: number;
  client: string;
}

export interface AuthChallenge {
  nonce: string; // base64, 32 bytes
}

export interface AuthResponse {
  mac: string; // base64 HMAC-SHA256(psk, nonce)
}

export interface AuthFail {
  reason: string;
}

export type SessionMode = "pty" | "exec";

export interface OpenSession {
  session_id: number;
  mode: SessionMode;
  cols: number;
  rows: number;
}

export interface SessionOpened {
  session_id: number;
}

export interface Resize {
  cols: number;
  rows: number;
}

export type SignalName = "INT" | "TERM" | "HUP";

export interface Exec {
  cmd: string;
  timeout_ms?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  truncated: boolean;
}

export interface CloseSession {
  session_id: number;
}

export interface Credit {
  session_id: number;
  n: number;
}

export interface ErrorMsg {
  code: string;
  msg: string;
}
