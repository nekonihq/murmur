# murmur

A remote shell for a Raspberry Pi that works **over Bluetooth Low Energy** — no network
required on the Pi. The Pi can be fully offline and headless; your phone is the only link.

Two halves:

- **`murmurd`** — a Rust daemon on the Pi that exposes a shell over a custom BLE GATT service.
- **murmur app** — a React Native app (iOS + Android) that connects over BLE and runs in two
  modes:
  - **Shell mode** — a real interactive terminal (xterm.js).
  - **Agent mode** — a chat UI where an LLM drives the shell for you, using **your own API
    keys** (bring-your-own) for Anthropic Claude, OpenAI, or Google Gemini.

The AI agent loop runs **on the phone**: the phone holds the API keys and the internet
connection, calls the LLM, and ships the resulting commands to the Pi over BLE. The Pi never
needs internet.

## Why BLE (and not Bluetooth Classic)

iOS forbids Bluetooth Classic / RFCOMM (the classic "serial port" profile) for apps outside
Apple's MFi hardware program. BLE works on both iOS (CoreBluetooth) and Android. So murmur
uses BLE: the **Pi is the GATT peripheral**, the **phone is the central**. BLE is
MTU-bounded and its notifications can be dropped under load, so murmur defines its own
framing + flow-control protocol on top of GATT — see [`PROTOCOL.md`](./PROTOCOL.md).

## Layout

```
daemon/   Rust daemon (murmurd) — runs on the Pi
app/      React Native app (iOS + Android)
docs/     PLAN.md and design notes
PROTOCOL.md   the wire protocol — single source of truth for both sides
```

## Status

Early development. See [`docs/PLAN.md`](./docs/PLAN.md) for the design and build order.

### Building the daemon

`murmurd` targets **Linux/BlueZ** (the BLE peripheral layer uses `bluer`, which is
Linux-only). The protocol and session logic are platform-independent and unit-tested on any
host:

```sh
cd daemon
cargo test          # protocol round-trip + flow-control tests (any OS)
cargo build         # full build incl. BLE — Linux only
```

### App

```sh
cd app
npm install
npm test            # protocol mirror round-trip tests (Jest)
```
