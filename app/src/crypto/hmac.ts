// HMAC-SHA256 over Uint8Array, matching the daemon's `hmac` + `sha2` crates.

import { sha256, SHA256_BLOCK } from "./sha256.ts";

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  // Keys longer than the block size are hashed first.
  let k = key;
  if (k.length > SHA256_BLOCK) k = sha256(k);

  const kPad = new Uint8Array(SHA256_BLOCK);
  kPad.set(k);

  const inner = new Uint8Array(SHA256_BLOCK);
  const outer = new Uint8Array(SHA256_BLOCK);
  for (let i = 0; i < SHA256_BLOCK; i++) {
    inner[i] = kPad[i] ^ 0x36;
    outer[i] = kPad[i] ^ 0x5c;
  }

  const innerMsg = new Uint8Array(SHA256_BLOCK + message.length);
  innerMsg.set(inner);
  innerMsg.set(message, SHA256_BLOCK);
  const innerHash = sha256(innerMsg);

  const outerMsg = new Uint8Array(SHA256_BLOCK + innerHash.length);
  outerMsg.set(outer);
  outerMsg.set(innerHash, SHA256_BLOCK);
  return sha256(outerMsg);
}
