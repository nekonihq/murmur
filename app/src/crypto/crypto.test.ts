// Run with: node --test src/crypto/crypto.test.ts
//
// These vectors guarantee the app's auth response matches what the Python daemon
// computes with `hmac`/`hashlib` — the same standard HMAC-SHA256.

import { test } from "node:test";
import assert from "node:assert/strict";

import { sha256 } from "./sha256.ts";
import { hmacSha256 } from "./hmac.ts";
import { toBase64, fromBase64 } from "./base64.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

test("sha256 of empty string (FIPS-180 known answer)", () => {
  assert.equal(
    hex(sha256(new Uint8Array(0))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("sha256 of 'abc' (FIPS-180 known answer)", () => {
  assert.equal(
    hex(sha256(enc("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("HMAC-SHA256 RFC 4231 test case 2", () => {
  // Key="Jefe", Data="what do ya want for nothing?"
  assert.equal(
    hex(hmacSha256(enc("Jefe"), enc("what do ya want for nothing?"))),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});

test("HMAC-SHA256 RFC 4231 test case 1", () => {
  const key = new Uint8Array(20).fill(0x0b);
  assert.equal(
    hex(hmacSha256(key, enc("Hi There"))),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );
});

test("HMAC with key longer than the block size (RFC 4231 case 6)", () => {
  const key = new Uint8Array(131).fill(0xaa);
  const data = enc("Test Using Larger Than Block-Size Key - Hash Key First");
  assert.equal(
    hex(hmacSha256(key, data)),
    "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
  );
});

test("base64 round-trips arbitrary bytes", () => {
  for (let len = 0; len < 40; len++) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
    assert.deepEqual(Array.from(fromBase64(toBase64(bytes))), Array.from(bytes));
  }
});

test("base64 matches a known encoding", () => {
  assert.equal(toBase64(enc("murmur")), "bXVybXVy");
  assert.deepEqual(Array.from(fromBase64("bXVybXVy")), Array.from(enc("murmur")));
});
