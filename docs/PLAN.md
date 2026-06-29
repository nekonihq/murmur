# Murmur — BLE Remote Shell + AI Agent for Raspberry Pi

## Context

`murmur` is a new, greenfield project (the working directory is empty). The goal is a
remote shell for a Raspberry Pi that works **over Bluetooth** — no network required on
the Pi. It has two halves:

1. **Daemon** (`murmurd`) running on the Pi — exposes a shell over BLE.
2. **Mobile app** (React Native, iOS + Android) — connects over BLE and runs in two modes:
   - **Shell mode** — a real interactive terminal.
   - **Agent mode** — a chat UI where an LLM drives the shell on the user's behalf, using
     **the user's own API keys** (BYO) for popular providers.

**Key architectural decisions (confirmed with the user):**
- **Transport: BLE (Bluetooth Low Energy).** Cross-platform forces this — iOS forbids
  Bluetooth Classic/RFCOMM without Apple's MFi hardware program; BLE works on both iOS and
  Android via CoreBluetooth / Android BLE. The Pi is the **GATT peripheral**, the phone is
  the **central**.
- **Agent loop runs on the phone.** The phone holds the API keys + internet, calls the LLM,
  and sends resulting commands to the Pi over BLE. **The Pi needs no internet** — it can be
  fully offline/headless. This is the whole point of the design.
- **Stack: React Native app + Rust daemon.**
- **MVP includes both modes** built together.

The central engineering constraint is that **BLE is a low-bandwidth, MTU-bounded,
lossy-notification transport**, so a framing/flow-control protocol is the heart of the
project — not an afterthought.

---

## Architecture overview

```
┌─────────────────────────── Phone (React Native) ───────────────────────────┐
│  Shell screen (xterm.js in WebView)     Agent screen (chat UI)              │
│             │                                  │                            │
│             │                          Agent loop (TS)                      │
│             │                          + provider adapters (Claude/OpenAI/  │
│             │                            Gemini, BYO keys in secure store)  │
│             └──────────────┬───────────────────┘                           │
│                     BLE transport layer (framing, chunking, flow control)   │
│                     via react-native-ble-plx                                 │
└───────────────────────────────┬────────────────────────────────────────────┘
                                 │  BLE GATT (custom service)
┌────────────────────────────────┴───────────────────── Raspberry Pi ────────┐
│  murmurd (Rust)                                                              │
│   BLE GATT server (bluer / BlueZ D-Bus)                                      │
│   ├── protocol: framing + session mux + flow control                        │
│   ├── auth: BLE bonding + app-level challenge/response                       │
│   ├── pty session  (interactive shell → shell mode)                         │
│   └── exec session (one-shot command+capture → agent mode)                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Two daemon execution paths, one wire protocol:**
- *PTY session* — allocate a pseudo-terminal, spawn the login shell, stream bytes both ways.
  Backs **shell mode** (interactive: editors, `top`, colors, Ctrl-C, resize).
- *Exec session* — run a single command, capture stdout/stderr/exit code, return as one
  result. Backs **agent mode** (the LLM tool call needs a clean, bounded result, not a PTY
  stream).

---

## Repository layout (monorepo)

```
murmur/
  README.md
  PROTOCOL.md            # the wire protocol spec — single source of truth, both sides implement it
  daemon/                # Rust — runs on the Pi
    Cargo.toml
    src/
      main.rs            # arg parsing, config, startup
      ble/mod.rs         # GATT server via bluer; TX/RX/CTRL characteristics
      protocol/mod.rs    # frame encode/decode, opcodes, session ids, flow control
      auth/mod.rs        # pairing token, challenge/response (HMAC)
      session/pty.rs     # PTY session (portable-pty)
      session/exec.rs    # one-shot exec session
      session/mod.rs     # session registry / multiplexer
  app/                   # React Native (iOS + Android)
    src/
      ble/transport.ts   # react-native-ble-plx wrapper + framing/reassembly/flow control
      protocol/          # TS mirror of PROTOCOL.md (opcodes, frame codec)
      terminal/          # xterm.js inside react-native-webview + bridge
      agent/loop.ts      # phone-side agent loop (tool-call → exec over BLE → result → repeat)
      providers/         # anthropic.ts | openai.ts | gemini.ts + common interface
      storage/keys.ts    # react-native-keychain wrapper for BYO API keys + pairing token
      screens/           # Shell, Agent, Devices, Settings
```

`PROTOCOL.md` is written **first** and both `daemon/src/protocol` and `app/src/protocol`
implement it. Keep opcodes/struct layout in sync by hand (small surface); optionally
generate later.

---

## Wire protocol (PROTOCOL.md)

**GATT service** with three characteristics (one custom 128-bit UUID per):
- `C2P` (central→peripheral) — **Write Without Response** for throughput, occasional
  **Write With Response** for sync points. Phone → Pi (stdin, commands, control).
- `P2C` (peripheral→central) — **Notify**. Pi → phone (stdout/stderr, results, control).
- `CTRL` — small **Write/Notify** for auth handshake + flow-control credits (keeps bulk
  data path uncluttered).

**Framing.** BLE payloads are MTU-bounded (negotiate ATT MTU up front; expect ~180–512B).
Each logical message is length-prefixed and split into MTU-sized chunks; the receiver
reassembles. Frame header:

```
[ver:u8][opcode:u8][session_id:u8][flags:u8][seq:u16][len:u16][payload…]
```

**Opcodes (initial set):**
`HELLO`, `AUTH_CHALLENGE`, `AUTH_RESPONSE`, `AUTH_OK`/`AUTH_FAIL`,
`OPEN_SESSION{mode: pty|exec, cols, rows}`, `DATA` (stdin/stdout/stderr bytes),
`RESIZE{cols,rows}`, `SIGNAL{sig}` (e.g. SIGINT for Ctrl-C),
`EXEC{cmd,timeout}` → `EXEC_RESULT{stdout,stderr,exit_code,truncated}`,
`CLOSE_SESSION`, `CREDIT{n}` (flow control), `ERROR{code,msg}`.

**Multiplexing.** `session_id` lets shell + agent sessions coexist over one connection.

**Flow control.** Notifications can be dropped if the central's buffer overflows. Use a
credit/window scheme on `CTRL`: the phone grants N credits; the Pi sends at most N unacked
`DATA` frames before waiting for more. Prevents overrunning the OS notification queue and
gives backpressure for large outputs (`cat bigfile`).

---

## Security / pairing

Remote shell access demands real auth — BLE bonding alone is insufficient (a bonded but
unauthorized phone must not get a shell).

- **Link layer:** require BLE bonding (LE Secure Connections); mark characteristics as
  requiring encryption in `bluer`.
- **App layer:** first-time pairing — the Pi generates a setup token (display a 6-digit code
  on first run / via `murmurd --show-pairing-code`, or print to its console). The phone
  enters it once; both sides derive a shared secret stored in
  Keychain/Keystore (phone) and a config file (Pi). On every reconnect, a `CTRL`
  challenge/response (HMAC over a nonce with the shared secret) gates `OPEN_SESSION`.
- **Least privilege:** `murmurd` runs the shell as a configurable non-root user by default;
  document running it under systemd as a dedicated `murmur` user. Do **not** default to root.

---

## App: the two modes

**Shell mode.** Embed `xterm.js` in `react-native-webview`. Wire xterm's `onData` (keystrokes)
→ `DATA`/`SIGNAL`/`RESIZE` frames → BLE; incoming `DATA` notifications → `term.write()`.
This gives a genuine terminal (ANSI, colors, cursor) without writing an emulator. The PTY
session on the daemon does the heavy lifting.

**Agent mode.** Chat UI. The **phone runs the agent loop**:
1. User states a goal in natural language.
2. App calls the selected provider with a system prompt + a single tool:
   `run_shell_command(command: string, timeout_seconds?: number)`.
3. The LLM returns a tool call → app sends `EXEC{cmd}` over BLE → Pi runs it (exec session,
   not PTY) → returns `EXEC_RESULT` → app feeds stdout/stderr/exit code back as the tool
   result → loop until the model produces a final answer (`stop_reason: end_turn`).
4. Stream assistant text to the UI; render each command + its output as an inline step the
   user can audit. Add a **confirm-before-run toggle** for destructive commands (the tool
   call is a natural gate — see Anthropic's "promote to a dedicated tool" guidance).

---

## LLM provider layer (BYO keys)

Common TS interface so the agent loop is provider-agnostic:

```ts
interface LLMProvider {
  name: string;
  runAgentTurn(messages, tools, opts): AsyncIterable<AssistantEvent>; // text + tool_use
}
```

Adapters normalize each vendor's tool-calling format to the one `run_shell_command` tool:
- **Anthropic (default).** Messages API tool-use loop. Default model **`claude-opus-4-8`**
  (also offer `claude-sonnet-4-6`, `claude-haiku-4-5`). Use `thinking: {type: "adaptive"}`
  and `output_config: {effort: ...}`; stream responses. React Native isn't a browser (no
  CORS), so call the API directly with `fetch` (or `@anthropic-ai/sdk` if it runs cleanly
  under RN/Hermes — verify; otherwise hand-rolled fetch against `/v1/messages`). The agentic
  loop = the manual tool-use loop: call → `stop_reason: tool_use` → exec over BLE → send
  `tool_result` → repeat. Reference: `claude-api` skill (Python/TS tool-use docs).
- **OpenAI.** Chat Completions / Responses with `tools` (function calling).
- **Gemini.** `generateContent` with `functionDeclarations`.

Keys live in **react-native-keychain** (Keychain / encrypted Keystore), never in JS bundle
or plaintext. Settings screen: pick provider, paste key, choose model.

---

## Build order (both modes together, but transport first)

1. **`PROTOCOL.md`** — define frames, opcodes, flow control, auth handshake.
2. **Daemon skeleton + BLE peripheral** — `bluer` GATT server advertising the service with
   the three characteristics; MTU negotiation; echo test (loopback `DATA`).
3. **App BLE transport** — scan/connect/bond via `react-native-ble-plx`, subscribe to `P2C`,
   implement framing/reassembly/credits; verify the echo round-trips.
4. **PTY session + shell mode** — daemon `portable-pty`; app xterm.js-in-WebView. End-to-end
   interactive shell.
5. **Auth/pairing** — challenge/response gating `OPEN_SESSION`; key storage both sides.
6. **Exec session + agent mode** — daemon one-shot exec; app agent loop + Anthropic adapter
   (default), then OpenAI + Gemini; secure key storage; confirm-before-run.
7. **Hardening** — flow-control tuning for large output, reconnection, non-root user,
   systemd unit for `murmurd`.

---

## Verification

- **Protocol unit tests** on both sides: encode→decode round-trips, chunking across MTU
  boundaries, reassembly, credit accounting (Rust `cargo test`; TS Jest).
- **Daemon on the Pi:** run `murmurd`, confirm it advertises via `bluetoothctl` /
  `sudo btmon`; exercise PTY + exec with a small host-side BLE central test script
  (e.g. Python `bleak`) before the app is ready.
- **Shell mode E2E:** connect from the app, run `vim`/`htop`/`ls --color`, Ctrl-C, resize —
  confirm rendering and signals.
- **Agent mode E2E:** with a real BYO key, give a goal like "what's the kernel version and
  free disk space?"; confirm the loop issues `uname -r` / `df -h`, feeds results back, and
  answers. Test confirm-before-run on a destructive command.
- **Resilience:** stream large output (`cat` a big file) to confirm flow control holds with
  no drops; drop/restore BLE range to confirm reconnect + re-auth.

---

## Open questions / deferred

- Exact GATT characteristic UUIDs (generate random 128-bit) — decide in `PROTOCOL.md`.
- Whether to verify `@anthropic-ai/sdk` runs under Hermes or commit to raw `fetch` — resolve
  during step 6.
- Multi-Pi management and BLE background reconnection — post-MVP.
