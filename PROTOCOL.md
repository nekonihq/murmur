# murmur wire protocol

Version: `1` (`PROTO_VERSION`).

This is the single source of truth. Both the Python daemon (`daemon/murmurd/protocol.py`) and
the app (`app/src/protocol`, TypeScript) implement exactly what is described here. Keep them in
sync.

BLE is a low-bandwidth, MTU-bounded transport whose notifications can be silently dropped
under load. This protocol therefore handles its own **framing**, **fragmentation**,
**session multiplexing**, **flow control**, and **authentication** on top of GATT.

## GATT service

One custom 128-bit service UUID with three characteristics. The `6d75726d` prefix is
`"murm"` in ASCII:

| Char | UUID                                   | Properties                      | Direction        | Use |
|------|----------------------------------------|---------------------------------|------------------|-----|
| `C2P`| `6d75726d-0000-4000-8000-000000000002` | Write, Write Without Response   | central → periph | stdin, commands, control |
| `P2C`| `6d75726d-0000-4000-8000-000000000003` | Notify                          | periph → central | stdout/stderr, results, control |
| `CTRL`| `6d75726d-0000-4000-8000-000000000004`| Write, Notify                   | both             | auth handshake + flow-control credits |

Service UUID: `6d75726d-0000-4000-8000-000000000001`.

Data frames flow on `C2P`/`P2C`; auth and `CREDIT` flow on `CTRL` so the bulk path stays
clean. Framing is identical on all three.

## Frame format

Every GATT write / notification carries exactly one **frame**. Fixed 8-byte big-endian
header, then payload:

```
 0      1       2          3        4   5      6   7     8 ...
+------+-------+----------+--------+--------+--------+----------+
| ver  |opcode |session_id| flags  |  seq   |  len   | payload  |
| u8   | u8    | u8       | u8     | u16 BE | u16 BE | len bytes|
+------+-------+----------+--------+--------+--------+----------+
```

- `ver` — `PROTO_VERSION` (1). Receiver rejects mismatches.
- `opcode` — see table below.
- `session_id` — 0 for connection-level frames (auth, credits); 1..=255 for sessions.
- `flags` — bit 0 `FRAG_MORE` (1 = more fragments follow for this logical message). Other
  bits reserved (0).
- `seq` — per-direction monotonic counter, wraps at 2^16. For ordering checks / debugging.
- `len` — payload byte length in this frame. Must satisfy `8 + len <= negotiated_mtu`.

### Fragmentation

A logical message whose encoded payload exceeds one frame's capacity is split across
consecutive frames with the **same `opcode` and `session_id`**: every fragment except the
last sets `FRAG_MORE`. The receiver concatenates payloads until a frame without `FRAG_MORE`,
then decodes the whole. Frames on a single characteristic are processed in arrival order, so
fragments never interleave across messages on the same characteristic.

`max_payload = negotiated_mtu - 8`. Negotiate the ATT MTU at connect; assume 23 (→ 15-byte
payload) until negotiated, expect 180–512 in practice.

## Opcodes

| Name              | Value | Char  | Payload (JSON unless noted) |
|-------------------|-------|-------|------------------------------|
| `HELLO`           | 0x01  | CTRL  | `{ "proto": 1, "client": "<name/version>" }` |
| `AUTH_CHALLENGE`  | 0x02  | CTRL  | `{ "nonce": "<base64, 32 bytes>" }` |
| `AUTH_RESPONSE`   | 0x03  | CTRL  | `{ "mac": "<base64 HMAC-SHA256>" }` |
| `AUTH_OK`         | 0x04  | CTRL  | `{}` |
| `AUTH_FAIL`       | 0x05  | CTRL  | `{ "reason": "<string>" }` |
| `OPEN_SESSION`    | 0x10  | C2P   | `{ "session_id": N, "mode": "pty"\|"exec", "cols": C, "rows": R }` |
| `SESSION_OPENED`  | 0x11  | P2C   | `{ "session_id": N }` |
| `DATA`            | 0x12  | both  | **raw bytes** (stdin on C2P, stdout/stderr on P2C). On P2C, `flags` bit 1 `STREAM_ERR` marks stderr. |
| `RESIZE`          | 0x13  | C2P   | `{ "cols": C, "rows": R }` (pty only) |
| `SIGNAL`          | 0x14  | C2P   | `{ "sig": "INT"\|"TERM"\|"HUP" }` (pty only) |
| `EXEC`            | 0x15  | C2P   | `{ "cmd": "<string>", "timeout_ms": T?, "sudo_password": "<string>"? }` (exec only) |
| `EXEC_RESULT`     | 0x16  | P2C   | `{ "stdout": "<utf8>", "stderr": "<utf8>", "exit_code": E, "truncated": bool }` |
| `CLOSE_SESSION`   | 0x17  | both  | `{ "session_id": N }` |
| `CREDIT`          | 0x20  | CTRL  | `{ "session_id": N, "n": <u16> }` |
| `ERROR`           | 0x7f  | both  | `{ "code": "<string>", "msg": "<string>" }` |

`DATA` payload is raw bytes (not JSON) for efficiency and binary-safety on the byte stream.
All other payloads are compact UTF-8 JSON. `EXEC_RESULT` carries shell output as UTF-8
strings (lossy for non-UTF-8 bytes — acceptable for the agent's command results).

`EXEC` commands run in a new session with no controlling terminal, so an interactive
`sudo` can't prompt on the Pi's console. When `sudo_password` is present the daemon exposes
it to sudo through an askpass helper (the secret stays in the child's environment, never on
disk); when absent, a password-requiring sudo fails fast instead of hanging. The central
sends `sudo_password` only for commands that invoke sudo.

## Connection lifecycle

```
central connects + bonds (BLE LE Secure Connections; chars require encryption)
        │
        ├─ central → CTRL: HELLO
        ├─ periph → CTRL: AUTH_CHALLENGE { nonce }
        ├─ central → CTRL: AUTH_RESPONSE { mac = HMAC-SHA256(psk, nonce) }
        ├─ periph → CTRL: AUTH_OK   (or AUTH_FAIL → disconnect)
        │
        ├─ central → C2P: OPEN_SESSION { id, mode, cols, rows }
        ├─ periph → P2C: SESSION_OPENED { id }
        ├─ central → CTRL: CREDIT { id, n }      # grant initial window
        │
        ├─ … DATA / EXEC / RESIZE / SIGNAL / CREDIT …
        │
        └─ CLOSE_SESSION (either side) / disconnect
```

Multiple sessions (e.g. one `pty` for shell mode + one `exec` for agent mode) coexist over a
single connection, distinguished by `session_id`.

## Authentication

- **Link layer:** require BLE bonding (LE Secure Connections); GATT characteristics require
  encryption. No session may be opened before `AUTH_OK`.
- **App layer:** a pre-shared key (`psk`, 32 random bytes) established once during pairing
  (see below). Each connection, the peripheral sends a fresh 32-byte `nonce`; the central
  replies with `HMAC-SHA256(psk, nonce)`. The peripheral recomputes and compares in constant
  time. This proves possession of the `psk` without sending it, and the per-connection nonce
  defeats replay.

### Pairing (one-time)

The daemon generates a random 256-bit `psk` on first run. To enroll a phone, run the daemon in
pairing mode (`murmurd --pair`), which prints the `psk` as a base64 string. The user pastes it
into the app's pairing screen once; the phone stores it in the OS secure store
(Keychain/Keystore). Thereafter every connection uses the runtime challenge/response above.

## Flow control (credit window)

Notifications can be lost if the central's buffer overflows, and the peripheral must not
outrun the central. Each **session** has a credit window for the peripheral→central
direction:

- The central grants credits with `CREDIT { session_id, n }` on `CTRL`.
- The peripheral may send at most `credits` `DATA`/`EXEC_RESULT` frames on `P2C` for that
  session; each sent frame decrements the window by 1.
- At 0 credits the peripheral pauses that session's output until more credits arrive.
- The central tops up credits as it drains/renders received frames (e.g. grant `N`, refill
  by `N/2` once half consumed).

Recommended initial window: 32 frames. Tune for large outputs (`cat bigfile`) so the pipe
stays full without dropping notifications.
