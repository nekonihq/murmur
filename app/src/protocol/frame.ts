// murmur wire protocol — TypeScript mirror of `daemon/src/protocol`.
//
// This is the app side of `PROTOCOL.md`. It must stay byte-compatible with the
// Rust implementation. Uses plain `Uint8Array` and `const` maps (no TS `enum`,
// so the file runs directly under Node's type-stripping and React Native).

export const PROTO_VERSION = 1;
export const HEADER_LEN = 8;
export const CONNECTION_SESSION = 0;

/** Frame flag bits (mirror of `protocol::flags`). */
export const Flags = {
  FRAG_MORE: 0x01,
  STREAM_ERR: 0x02,
} as const;

/** Wire opcodes (mirror of `protocol::Opcode`). */
export const Opcode = {
  Hello: 0x01,
  AuthChallenge: 0x02,
  AuthResponse: 0x03,
  AuthOk: 0x04,
  AuthFail: 0x05,
  OpenSession: 0x10,
  SessionOpened: 0x11,
  Data: 0x12,
  Resize: 0x13,
  Signal: 0x14,
  Exec: 0x15,
  ExecResult: 0x16,
  CloseSession: 0x17,
  Credit: 0x20,
  Error: 0x7f,
} as const;

export type OpcodeValue = (typeof Opcode)[keyof typeof Opcode];

const KNOWN_OPCODES: Set<number> = new Set(Object.values(Opcode));

export interface Frame {
  opcode: OpcodeValue;
  sessionId: number;
  flags: number;
  seq: number;
  payload: Uint8Array;
}

/** Max payload bytes that fit in one frame for a negotiated ATT MTU. */
export function maxPayload(mtu: number): number {
  return Math.max(0, mtu - HEADER_LEN);
}

export function hasMore(frame: Frame): boolean {
  return (frame.flags & Flags.FRAG_MORE) !== 0;
}

export class ProtocolError extends Error {}

/** Serialize a frame to wire bytes (8-byte big-endian header + payload). */
export function encodeFrame(frame: Frame): Uint8Array {
  if (frame.payload.length > 0xffff) {
    throw new ProtocolError(`payload too large: ${frame.payload.length}`);
  }
  const out = new Uint8Array(HEADER_LEN + frame.payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, PROTO_VERSION);
  view.setUint8(1, frame.opcode);
  view.setUint8(2, frame.sessionId & 0xff);
  view.setUint8(3, frame.flags & 0xff);
  view.setUint16(4, frame.seq & 0xffff, false); // big-endian
  view.setUint16(6, frame.payload.length, false);
  out.set(frame.payload, HEADER_LEN);
  return out;
}

/** Parse one frame from wire bytes. */
export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.length < HEADER_LEN) {
    throw new ProtocolError(`frame too short: ${buf.length}`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ver = view.getUint8(0);
  if (ver !== PROTO_VERSION) {
    throw new ProtocolError(`unsupported version ${ver}`);
  }
  const opcode = view.getUint8(1);
  if (!KNOWN_OPCODES.has(opcode)) {
    throw new ProtocolError(`unknown opcode 0x${opcode.toString(16)}`);
  }
  const sessionId = view.getUint8(2);
  const flags = view.getUint8(3);
  const seq = view.getUint16(4, false);
  const len = view.getUint16(6, false);
  const payload = buf.subarray(HEADER_LEN);
  if (payload.length !== len) {
    throw new ProtocolError(`declared len ${len} != actual ${payload.length}`);
  }
  return { opcode: opcode as OpcodeValue, sessionId, flags, seq, payload };
}

/** Mutable sequence counter passed to {@link fragment}. */
export interface SeqCounter {
  value: number;
}

/**
 * Split a logical message into frames no larger than `max`. `baseFlags` is
 * OR-ed into every fragment; `FRAG_MORE` is managed here. Advances `seq.value`
 * once per frame (wrapping at 2^16).
 */
export function fragment(
  opcode: OpcodeValue,
  sessionId: number,
  baseFlags: number,
  payload: Uint8Array,
  max: number,
  seq: SeqCounter,
): Frame[] {
  const chunkSize = Math.max(1, max);
  const frames: Frame[] = [];
  const total = payload.length === 0 ? 1 : Math.ceil(payload.length / chunkSize);
  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    const chunk = payload.subarray(start, start + chunkSize);
    let flags = baseFlags & ~Flags.FRAG_MORE;
    if (i !== total - 1) flags |= Flags.FRAG_MORE;
    frames.push({
      opcode,
      sessionId,
      flags,
      seq: seq.value & 0xffff,
      payload: chunk,
    });
    seq.value = (seq.value + 1) & 0xffff;
  }
  return frames;
}

/** A fully reassembled logical message. */
export interface Message {
  opcode: OpcodeValue;
  sessionId: number;
  flags: number;
  payload: Uint8Array;
}

/**
 * Rebuilds logical {@link Message}s from frames on one characteristic.
 * Accumulates per `(sessionId, opcode)` key, mirroring the Rust `Reassembler`.
 */
export class Reassembler {
  private partial = new Map<string, number[]>();

  push(frame: Frame): Message | null {
    const key = `${frame.sessionId}:${frame.opcode}`;
    if (hasMore(frame)) {
      const buf = this.partial.get(key) ?? [];
      for (const b of frame.payload) buf.push(b);
      this.partial.set(key, buf);
      return null;
    }
    let payload: Uint8Array;
    const buffered = this.partial.get(key);
    if (buffered) {
      this.partial.delete(key);
      for (const b of frame.payload) buffered.push(b);
      payload = Uint8Array.from(buffered);
    } else {
      payload = frame.payload;
    }
    return {
      opcode: frame.opcode,
      sessionId: frame.sessionId,
      flags: frame.flags,
      payload,
    };
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** JSON-encode a value to a UTF-8 payload. */
export function jsonPayload(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

/** Decode a UTF-8 JSON payload. */
export function parseJson<T>(payload: Uint8Array): T {
  return JSON.parse(textDecoder.decode(payload)) as T;
}
