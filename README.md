# murmur

A remote shell for a Raspberry Pi that works **over Bluetooth Low Energy** — no network
required on the Pi. The Pi can be fully offline and headless; your phone is the only link.

Two halves:

- **`murmurd`** — a Python daemon on the Pi that exposes a shell over a custom BLE GATT
  service — no compilation needed, just BlueZ and a venv.
- **murmur app** — a React Native app (iOS + Android) that connects over BLE and runs in two
  modes:
  - **Shell mode** — a real interactive terminal (xterm.js).
  - **Agent mode** — a chat UI where an LLM drives the shell for you, using **your own API
    keys** (bring-your-own) for Anthropic Claude, OpenAI, or Google Gemini. Conversations are
    saved on the phone so you can revisit and resume past sessions.

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
daemon/        Python daemon (murmurd) — runs on the Pi
app/           React Native / Expo app (iOS + Android)
docs/          PLAN.md and design notes
PROTOCOL.md    the wire protocol — single source of truth for both sides
```

## Security

`murmurd` runs the shell as a **non-root** user, and the sample systemd unit is hardened
(`NoNewPrivileges`, `ProtectSystem=strict`). The agent can run `sudo` — the app sends the
password over the encrypted link — **only if** the service is configured to permit privilege
escalation; the hardened default blocks it. See
[`daemon/README.md`](./daemon/README.md#privileges--sudo) for how (and the tradeoff: whoever
can pair a phone then effectively has root on the Pi).

## Status

Early development. See [`docs/PLAN.md`](./docs/PLAN.md) for the design and build order.

### The daemon

`murmurd` (Python) targets **Linux/BlueZ** (the BLE peripheral uses `bless`). The protocol,
auth, flow-control, exec, and config logic are platform-independent and unit-tested on any
host with the standard library — no pip install needed:

```sh
cd daemon
python3 -m unittest discover -s tests -t .   # protocol/auth/flow-control/exec tests (any OS)
```

Install on the Pi with a venv (no compilation) — see [`daemon/README.md`](./daemon/README.md).

### App

```sh
cd app
npm install
npm test            # protocol mirror round-trip tests (node --test)
```
