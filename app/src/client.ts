// High-level murmur client: connection + auth handshake + session multiplexing
// + outbound flow-control credits, sitting on top of the BLE transport. The
// shell screen and the agent loop talk to this, not to BLE directly.

import { BleTransport, type NotifyChannel } from "./ble/transport.ts";
import { log } from "./log.ts";
import { hmacSha256 } from "./crypto/hmac.ts";
import { toBase64, fromBase64 } from "./crypto/base64.ts";
import {
  Opcode,
  Flags,
  CONNECTION_SESSION,
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

/**
 * Backstop timeout for agent-mode commands when the model doesn't request one.
 * Without it, a blocking command (a server, `journalctl -f`, an apt prompt…)
 * never returns and the agent loop hangs forever. The model can still ask for
 * longer via the tool's `timeout_seconds`.
 */
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

/**
 * Extra time allowed on top of the exec's own timeout before the client gives
 * up waiting for a result, covering the BLE round trip and any queuing delay
 * rather than racing the daemon's own deadline exactly.
 */
const EXEC_TIMEOUT_SLACK_MS = 15_000;

const PROTO_VERSION = 1;

/** Fail the connect attempt if the handshake doesn't complete in time. */
const HANDSHAKE_TIMEOUT_MS = 15000;

/** Keep the BLE link from going fully idle (which drops it after ~10s). */
const KEEPALIVE_MS = 4000;

type Pending<T> = { resolve: (v: T) => void; reject: (e: Error) => void };

/** Reject `p` if it hasn't settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Log a rejected fire-and-forget BLE write (e.g. after a disconnect) without
 *  turning it into an uncaught promise rejection. */
function swallow(e: unknown): void {
  console.warn("murmur: BLE write failed:", e);
}

export class MurmurClient {
  private transport = new BleTransport();
  private psk: Uint8Array;
  private reP2c = new Reassembler();
  private reCtrl = new Reassembler();
  private seqC2p: SeqCounter = { value: 0 };
  private seqCtrl: SeqCounter = { value: 0 };
  // Per-channel write mutex. Sequence numbers are assigned when a message is
  // fragmented, and the daemon's reassembler treats any gap in the per-channel
  // sequence as a lost frame (dropping in-progress reassembly). Concurrent
  // senders sharing a channel would interleave their awaited writes and put
  // frames on the wire out of seq order, corrupting fragmented messages. Chain
  // each channel's sends so a message's frames stay contiguous and in order.
  private sendTail: { c2p: Promise<void>; ctrl: Promise<void> } = {
    c2p: Promise.resolve(),
    ctrl: Promise.resolve(),
  };

  private authPending: Pending<void> | null = null;
  private openPending = new Map<number, Pending<void>>();
  private execPending = new Map<number, Pending<ExecResult>>();
  private dataHandlers = new Map<number, (bytes: Uint8Array, isErr: boolean) => void>();

  // Per-session credit accounting (frames granted vs received).
  private granted = new Map<number, number>();
  private received = new Map<number, number>();

  private execSessionReady = false;
  private onDiscCb: ((reason: Error) => void) | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private openSessions = new Set<number>();

  constructor(psk: Uint8Array) {
    this.psk = psk;
  }

  /** Notified when the link drops (after internal pending promises are failed). */
  onDisconnected(cb: (reason: Error) => void): void {
    this.onDiscCb = cb;
  }

  get transportRef(): BleTransport {
    return this.transport;
  }

  /** Connect to a device and complete the auth handshake. */
  async connect(deviceId: string): Promise<void> {
    log("client", "connect start", deviceId);
    await this.transport.connect(deviceId);
    // A link drop (common when the peripheral isn't really serving GATT) must
    // reject anything in flight rather than hang or throw uncaught later.
    this.transport.onDisconnected((reason) => {
      const err = reason ?? new Error("peripheral disconnected");
      this.failAll(err);
      this.onDiscCb?.(err);
    });
    this.transport.listen((chan, bytes) => this.onBytes(chan, bytes));
    const authed = new Promise<void>((resolve, reject) => {
      this.authPending = { resolve, reject };
    });
    const hello: Hello = { proto: PROTO_VERSION, client: "murmur-app/0.1" };
    await this.sendCtrl(Opcode.Hello, 0, jsonPayload(hello));
    await withTimeout(
      authed,
      HANDSHAKE_TIMEOUT_MS,
      "handshake timed out — is murmurd running and advertising on the Pi?",
    );
    log("client", "authenticated");
    this.startKeepAlive();
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    // A zero-credit CREDIT is a no-op for the daemon but keeps BLE traffic
    // flowing so the link isn't torn down for being idle.
    this.keepAlive = setInterval(() => {
      log("ka", "tick");
      if (this.openSessions.size === 0) {
        // No session yet — a zero-credit grant just keeps the link warm.
        this.grant(CONNECTION_SESSION, 0).catch(swallow);
      } else {
        // Top up each session's credits. This is the safety net that breaks a
        // credit deadlock caused by lost notifications (the daemon caps the
        // total, so this can't over-grant).
        for (const id of this.openSessions) {
          this.grant(id, CREDIT_WINDOW).catch(swallow);
        }
      }
    }, KEEPALIVE_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  /** Reject every pending promise (used on disconnect / fatal error). */
  private failAll(error: Error): void {
    log("client", "failAll:", error.message);
    this.stopKeepAlive();
    this.openSessions.clear();
    this.execSessionReady = false;
    this.authPending?.reject(error);
    this.authPending = null;
    for (const p of this.openPending.values()) p.reject(error);
    this.openPending.clear();
    for (const p of this.execPending.values()) p.reject(error);
    this.execPending.clear();
  }

  async disconnect(): Promise<void> {
    this.stopKeepAlive();
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
    this.sendC2p(Opcode.Data, SHELL_SESSION, bytes).catch(swallow);
  }

  resize(cols: number, rows: number): void {
    this.sendC2p(Opcode.Resize, SHELL_SESSION, jsonPayload({ cols, rows })).catch(swallow);
  }

  signal(sig: SignalName): void {
    this.sendC2p(Opcode.Signal, SHELL_SESSION, jsonPayload(sig)).catch(swallow);
  }

  // ---- Agent mode -------------------------------------------------------

  /** Run a command on the Pi and resolve with its result (agent mode). */
  async exec(
    command: string,
    timeoutMs?: number,
    sudoPassword?: string,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    if (signal?.aborted) throw new Error("aborted");
    if (!this.execSessionReady) {
      await this.openSession(EXEC_SESSION, "exec", 0, 0);
      this.execSessionReady = true;
    }
    const effectiveTimeoutMs = timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const result = new Promise<ExecResult>((resolve, reject) => {
      this.execPending.set(EXEC_SESSION, { resolve, reject });
    });
    // On Stop: reject immediately so the UI unblocks, and ask the Pi to kill the
    // running command (CLOSE_SESSION). Reopen the exec session next time so a
    // late result from the killed command can't land on a fresh request.
    const onAbort = () => {
      const pending = this.execPending.get(EXEC_SESSION);
      if (pending) {
        this.execPending.delete(EXEC_SESSION);
        pending.reject(new Error("aborted"));
      }
      this.execSessionReady = false;
      this.sendC2p(
        Opcode.CloseSession,
        EXEC_SESSION,
        jsonPayload({ session_id: EXEC_SESSION }),
      ).catch(swallow);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const payload = jsonPayload({
      cmd: command,
      timeout_ms: effectiveTimeoutMs,
      ...(sudoPassword ? { sudo_password: sudoPassword } : {}),
    });
    try {
      await this.sendC2p(Opcode.Exec, EXEC_SESSION, payload);
      // Backstop: the daemon enforces `timeout_ms` and always replies, but BLE
      // notifications aren't guaranteed delivery — a dropped fragment carrying
      // the result would otherwise leave this promise (and the agent loop)
      // hanging forever with no error and no recovery. Give the round trip
      // some slack over the daemon's own deadline before giving up.
      return await withTimeout(
        result,
        effectiveTimeoutMs + EXEC_TIMEOUT_SLACK_MS,
        "no response from the Pi — the command result never arrived (lost connection?)",
      );
    } catch (e) {
      // A timed-out exec's late result could otherwise land on the next
      // request, so drop the session and force a reopen (same recovery as an
      // aborted exec above).
      if (this.execPending.delete(EXEC_SESSION)) {
        this.execSessionReady = false;
        this.sendC2p(
          Opcode.CloseSession,
          EXEC_SESSION,
          jsonPayload({ session_id: EXEC_SESSION }),
        ).catch(swallow);
      }
      throw e;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
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
    this.openSessions.add(id);
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
      this.grant(sessionId, top).catch(swallow);
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
        this.openSessions.delete(msg.sessionId);
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

  private sendFragments(
    chan: "c2p" | "ctrl",
    opcode: OpcodeValue,
    sessionId: number,
    payload: Uint8Array,
    seq: SeqCounter,
  ): Promise<void> {
    // Serialize per channel: fragment (which assigns sequence numbers) and the
    // writes must run as one uninterrupted unit so wire order == seq order.
    const run = this.sendTail[chan].then(async () => {
      const max = maxPayload(this.transport.negotiatedMtu());
      const frames = fragment(opcode, sessionId, 0, payload, max, seq);
      for (const f of frames) {
        await this.transport.send(chan, encodeFrame(f));
      }
    });
    // Keep the chain alive even if this send rejects, so one failure doesn't
    // wedge the channel; callers still observe the rejection via `run`.
    this.sendTail[chan] = run.catch(() => {});
    return run;
  }
}
