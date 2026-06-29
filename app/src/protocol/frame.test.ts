// Run with: node --test src/protocol/
// (Node 24 strips TypeScript types natively — no build step needed.)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Opcode,
  Flags,
  PROTO_VERSION,
  HEADER_LEN,
  encodeFrame,
  decodeFrame,
  fragment,
  hasMore,
  maxPayload,
  Reassembler,
  ProtocolError,
  type Frame,
  type SeqCounter,
} from "./frame.ts";

test("golden vector matches the Rust encoding", () => {
  // Must equal the bytes asserted in daemon `header_layout_is_eight_bytes`:
  // ver=1, opcode=Data(0x12), session=7, flags=STREAM_ERR(0x02), seq=0x1234, len=2, "hi"
  const frame: Frame = {
    opcode: Opcode.Data,
    sessionId: 7,
    flags: Flags.STREAM_ERR,
    seq: 0x1234,
    payload: new TextEncoder().encode("hi"),
  };
  const bytes = encodeFrame(frame);
  assert.deepEqual(
    Array.from(bytes),
    [0x01, 0x12, 0x07, 0x02, 0x12, 0x34, 0x00, 0x02, 0x68, 0x69],
  );
});

test("encode/decode round-trip", () => {
  const frame: Frame = {
    opcode: Opcode.Exec,
    sessionId: 3,
    flags: Flags.FRAG_MORE,
    seq: 65535,
    payload: Uint8Array.from([0, 1, 2, 250, 255]),
  };
  const decoded = decodeFrame(encodeFrame(frame));
  assert.equal(decoded.opcode, frame.opcode);
  assert.equal(decoded.sessionId, frame.sessionId);
  assert.equal(decoded.flags, frame.flags);
  assert.equal(decoded.seq, frame.seq);
  assert.deepEqual(Array.from(decoded.payload), Array.from(frame.payload));
});

test("decode rejects short and bad-version frames", () => {
  assert.throws(() => decodeFrame(Uint8Array.from([1, 2, 3])), ProtocolError);
  const bytes = encodeFrame({
    opcode: Opcode.Hello,
    sessionId: 0,
    flags: 0,
    seq: 0,
    payload: new Uint8Array(0),
  });
  bytes[0] = 99;
  assert.throws(() => decodeFrame(bytes), ProtocolError);
});

test("decode rejects length mismatch", () => {
  const bytes = encodeFrame({
    opcode: Opcode.Data,
    sessionId: 1,
    flags: 0,
    seq: 0,
    payload: new TextEncoder().encode("abc"),
  });
  // Drop one payload byte; header still claims 3.
  assert.throws(() => decodeFrame(bytes.subarray(0, bytes.length - 1)), ProtocolError);
});

test("fragment marks all but the last and preserves base flags", () => {
  const seq: SeqCounter = { value: 0 };
  const payload = Uint8Array.from({ length: 50 }, (_, i) => i);
  const frames = fragment(Opcode.Data, 2, Flags.STREAM_ERR, payload, 20, seq);
  assert.equal(frames.length, 3); // 20 + 20 + 10
  assert.ok(hasMore(frames[0]));
  assert.ok(hasMore(frames[1]));
  assert.ok(!hasMore(frames[2]));
  // STREAM_ERR on every fragment; FRAG_MORE only on non-last.
  assert.equal(frames[0].flags, Flags.STREAM_ERR | Flags.FRAG_MORE);
  assert.equal(frames[2].flags, Flags.STREAM_ERR);
  assert.equal(seq.value, 3);
});

test("fragment of empty payload is one frame", () => {
  const seq: SeqCounter = { value: 5 };
  const frames = fragment(Opcode.AuthOk, 0, 0, new Uint8Array(0), 100, seq);
  assert.equal(frames.length, 1);
  assert.ok(!hasMore(frames[0]));
  assert.equal(frames[0].payload.length, 0);
  assert.equal(seq.value, 6);
});

test("fragmentation round-trips through a tiny MTU", () => {
  const mtu = 23;
  const max = maxPayload(mtu);
  const original = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
  const seq: SeqCounter = { value: 0 };
  const frames = fragment(Opcode.Data, 9, 0, original, max, seq);
  const re = new Reassembler();
  let rebuilt: Uint8Array | null = null;
  for (const f of frames) {
    const bytes = encodeFrame(f);
    assert.ok(bytes.length <= mtu);
    const msg = re.push(decodeFrame(bytes));
    if (msg) rebuilt = msg.payload;
  }
  assert.deepEqual(Array.from(rebuilt!), Array.from(original));
});

test("reassembler handles single-frame messages", () => {
  const re = new Reassembler();
  const msg = re.push({
    opcode: Opcode.Hello,
    sessionId: 0,
    flags: 0,
    seq: 0,
    payload: new TextEncoder().encode("{}"),
  });
  assert.ok(msg);
  assert.equal(msg!.opcode, Opcode.Hello);
});

test("reassembler resyncs after a lost frame (sequence gap)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const re = new Reassembler();
  // Message A starts at seq 0 (more fragments to come).
  re.push({ opcode: Opcode.Data, sessionId: 1, flags: Flags.FRAG_MORE, seq: 0, payload: enc("aa") });
  // seq 1 is lost; the next frame is the start of a new message at seq 2.
  // The gap must drop A's partial so it can't corrupt the new message.
  assert.equal(
    re.push({ opcode: Opcode.Data, sessionId: 1, flags: Flags.FRAG_MORE, seq: 2, payload: enc("bb") }),
    null,
  );
  const msg = re.push({ opcode: Opcode.Data, sessionId: 1, flags: 0, seq: 3, payload: enc("cc") });
  assert.ok(msg);
  // "bbcc" — NOT "aabbcc"; A's stale "aa" was discarded on the gap.
  assert.equal(new TextDecoder().decode(msg!.payload), "bbcc");
});

test("header length constant is 8", () => {
  assert.equal(HEADER_LEN, 8);
  assert.equal(PROTO_VERSION, 1);
});
