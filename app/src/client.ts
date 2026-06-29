// High-level murmur client: connection + auth handshake + session multiplexing
// + outbound flow-control credits, sitting on top of the BLE transport. The
// shell screen and the agent loop talk to this, not to BLE directly.

import { BleTransport, type NotifyChannel } from "./ble/transport.ts";
import { hmacSha256 } from "./crypto/hmac.ts";
import { toBase64, fromBase64 } from "./crypto/base64.ts";
import {
  Opcode,
  Flags,
  Reassembler,
  decodeFrame,
  encodeFrame,
  fragment,
  jsonPayload,
  parseJson,
  maxPayload,
  type Message,
  type OpcodeValue,
  type SeqCounter,
} from "./protocol/frame.ts";
import type {
  AuthChallenge,
  AuthResponse,
  ExecResult,
  Hello,
  OpenSession,
  SessionMode,
  SignalName,
} from "./protocol/messages.ts";

/** Reserved session ids. */
export const SHELL_SESSION = 1;
export const EXEC_SESSION = 2;

/** Credit window granted to the Pi per session (frames it may send to us). */
const CREDIT_WINDOW = 32;
const CREDIT_REFILL_AT = 16;

const PROTO_VERSION = 1;

type Pending<T> = { resolve: (v: T) => void; reject: (e: Error) => void };

export class MurmurClient {
  private transport = new BleTransport();
  private psk: Uint8Array;
  private reP2c = new Reassembler();
  private reCtrl = new Reassembler();
  private seqC2p: SeqCounter = { value: 0 };
  private seqCtrl: SeqCounter = { value: 0 };

  private authPending: Pending<void> | null = null;
  private openPending = new Map<number, Pending<void>>();
  private execPending = new Map<number, Pending<ExecResult>>();
  private dataHandlers = new Map<number, (bytes: Uint8Array, isErr: boolean) => void>();

  // Per-session credit accounting (frames granted vs received).
  private granted = new Map<number, number>();
  private received = new Map<number, number>();

  private execSessionReady = false;

  constructor(psk: Uint8Array) {
    this.psk = psk;
  }

  get transportRef(): BleTransport {
    return this.transport;
  }

  /** Connect to a device and complete the auth handshake. */
  async connect(deviceId: string): Promise<void> {
    await this.transport.connect(deviceId);
    this.transport.listen((chan, bytes) => this.onBytes(chan, bytes));
    const authed = new Promise<void>((resolve, reject) => {
      this.authPending = { resolve, reject };
    });
    const hello: Hello = { proto: PROTO_VERSION, client: "murmur-app/0.1" };
    await this.sendCtrl(Opcode.Hello, 0, jsonPayload(hello));
    await authed;
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect();
  }

  // ---- Shell mode -------------------------------------------------------

  /** Open the interactive shell (pty) session and route its output to `onData`. */
  async openShell(
    cols: number,
    rows: number,
    onData: (bytes: Uint8Array, isErr: boolean) => void,
  ): Promise<void> {
    this.dataHandlers.set(SHELL_SESSION, onData);
    await this.openSession(SHELL_SESSION, "pty", cols, rows);
  }

  sendStdin(bytes: Uint8Array): void {
    void this.sendC2p(Opcode.Data, SHELL_SESSION, bytes);
  }

  resize(cols: number, rows: number): void {
    void this.sendC2p(Opcode.Resize, SHELL_SESSION, jsonPayload({ cols, rows }));
  }

  signal(sig: SignalName): void {
    void this.sendC2p(Opcode.Signal, SHELL_SESSION, jsonPayload(sig));
  }

  // ---- Agent mode -------------------------------------------------------

  /** Run a command on the Pi and resolve with its result (agent mode). */
  async exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    if (!this.execSessionReady) {
      await this.openSession(EXEC_SESSION, "exec", 0, 0);
      this.execSessionReady = true;
    }
    const result = new Promise<ExecResult>((resolve, reject) => {
      this.execPending.set(EXEC_SESSION, { resolve, reject });
    });
    const payload = jsonPayload({
      cmd: command,
      ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
    });
    await this.sendC2p(Opcode.Exec, EXEC_SESSION, payload);
    return result;
  }

  // ---- Session + flow-control plumbing ---------------------------------

  private async openSession(
    id: number,
    mode: SessionMode,
    cols: number,
    rows: number,
  ): Promise<void> {
    const opened = new Promise<void>((resolve, reject) => {
      this.openPending.set(id, { resolve, reject });
    });
    const open: OpenSession = { session_id: id, mode, cols, rows };
    await this.sendC2p(Opcode.OpenSession, id, jsonPayload(open));
    await opened;
    await this.grant(id, CREDIT_WINDOW);
    this.granted.set(id, CREDIT_WINDOW);
    this.received.set(id, 0);
  }

  private async grant(sessionId: number, n: number): Promise<void> {
    await this.sendCtrl(Opcode.Credit, 0, jsonPayload({ session_id: sessionId, n }));
  }

  /** Refill credits as the Pi consumes its window (one credit per inbound frame). */
  private maybeRefill(sessionId: number): void {
    const granted = this.granted.get(sessionId);
    const received = this.received.get(sessionId);
    if (granted == null || received == null) return;
    const remaining = granted - received;
    if (remaining <= CREDIT_REFILL_AT) {
      const top = CREDIT_WINDOW - remaining;
      this.granted.set(sessionId, granted + top);
      void this.grant(sessionId, top);
    }
  }

  // ---- Inbound ----------------------------------------------------------

  private onBytes(chan: NotifyChannel, bytes: Uint8Array): void {
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return; // drop malformed
    }

    // Count flow-controlled inbound frames for credit refills.
    if (chan === "p2c" && (frame.opcode === Opcode.Data || frame.opcode === Opcode.ExecResult)) {
      const r = (this.received.get(frame.sessionId) ?? 0) + 1;
      this.received.set(frame.sessionId, r);
      this.maybeRefill(frame.sessionId);
    }

    const re = chan === "ctrl" ? this.reCtrl : this.reP2c;
    const msg = re.push(frame);
    if (!msg) return;
    if (chan === "ctrl") this.onCtrl(msg);
    else this.onP2c(msg);
  }

  private async onCtrl(msg: Message): Promise<void> {
    switch (msg.opcode) {
      case Opcode.AuthChallenge: {
        const { nonce } = parseJson<AuthChallenge>(msg.payload);
        const mac = hmacSha256(this.psk, fromBase64(nonce));
        const resp: AuthResponse = { mac: toBase64(mac) };
        await this.sendCtrl(Opcode.AuthResponse, 0, jsonPayload(resp));
        break;
      }
      case Opcode.AuthOk:
        this.authPending?.resolve();
        this.authPending = null;
        break;
      case Opcode.AuthFail:
        this.authPending?.reject(new Error("authentication failed"));
        this.authPending = null;
        break;
    }
  }

  private onP2c(msg: Message): void {
    switch (msg.opcode) {
      case Opcode.SessionOpened: {
        this.openPending.get(msg.sessionId)?.resolve();
        this.openPending.delete(msg.sessionId);
        break;
      }
      case Opcode.Data: {
        const handler = this.dataHandlers.get(msg.sessionId);
        handler?.(msg.payload, (msg.flags & Flags.STREAM_ERR) !== 0);
        break;
      }
      case Opcode.ExecResult: {
        const pending = this.execPending.get(msg.sessionId);
        if (pending) {
          this.execPending.delete(msg.sessionId);
          pending.resolve(parseJson<ExecResult>(msg.payload));
        }
        break;
      }
      case Opcode.CloseSession: {
        this.dataHandlers.delete(msg.sessionId);
        break;
      }
      case Opcode.Error: {
        // Reject anything awaiting on this session.
        const err = new Error(`daemon error: ${new TextDecoder().decode(msg.payload)}`);
        this.openPending.get(msg.sessionId)?.reject(err);
        this.openPending.delete(msg.sessionId);
        this.execPending.get(msg.sessionId)?.reject(err);
        this.execPending.delete(msg.sessionId);
        break;
      }
    }
  }

  // ---- Outbound ---------------------------------------------------------

  private async sendC2p(opcode: OpcodeValue, sessionId: number, payload: Uint8Array): Promise<void> {
    await this.sendFragments("c2p", opcode, sessionId, payload, this.seqC2p);
  }

  private async sendCtrl(
    opcode: OpcodeValue,
    sessionId: number,
    payload: Uint8Array,
  ): Promise<void> {
    await this.sendFragments("ctrl", opcode, sessionId, payload, this.seqCtrl);
  }

  private async sendFragments(
    chan: "c2p" | "ctrl",
    opcode: OpcodeValue,
    sessionId: number,
    payload: Uint8Array,
    seq: SeqCounter,
  ): Promise<void> {
    const max = maxPayload(this.transport.negotiatedMtu());
    const frames = fragment(opcode, sessionId, 0, payload, max, seq);
    for (const f of frames) {
      await this.transport.send(chan, encodeFrame(f));
    }
  }
}
