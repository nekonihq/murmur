// Base64 codec over Uint8Array. react-native-ble-plx exchanges characteristic
// values as base64 strings, and auth nonces/MACs are base64 in the protocol, so
// we need a codec that does not depend on a global atob/btoa (unreliable in RN).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63] +
      ALPHABET[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + "=";
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  // Strip whitespace, padding, and any non-alphabet characters.
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const len = clean.length;
  const fullGroups = Math.floor(len / 4);
  const rem = len - fullGroups * 4; // 0, 2, or 3 (1 is invalid base64)
  const outLen = fullGroups * 3 + (rem === 0 ? 0 : rem - 1);
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  for (; i < fullGroups * 4; i += 4) {
    const n =
      (LOOKUP[clean.charCodeAt(i)] << 18) |
      (LOOKUP[clean.charCodeAt(i + 1)] << 12) |
      (LOOKUP[clean.charCodeAt(i + 2)] << 6) |
      LOOKUP[clean.charCodeAt(i + 3)];
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  if (rem === 2) {
    const n = (LOOKUP[clean.charCodeAt(i)] << 18) | (LOOKUP[clean.charCodeAt(i + 1)] << 12);
    out[o++] = (n >> 16) & 0xff;
  } else if (rem === 3) {
    const n =
      (LOOKUP[clean.charCodeAt(i)] << 18) |
      (LOOKUP[clean.charCodeAt(i + 1)] << 12) |
      (LOOKUP[clean.charCodeAt(i + 2)] << 6);
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
  }
  return out;
}
