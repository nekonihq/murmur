# murmur

**Talk to your Raspberry Pi. No network required on the Pi — just your phone and Bluetooth.**

murmur turns your phone into an AI agent for a headless Pi: give it a goal in plain English
("what's eating my disk space?", "set up a static IP"), and it plans and runs shell commands
on the Pi for you, showing every command and its output as it goes. It also doubles as a
plain remote terminal when you'd rather drive the shell yourself. Either way, the Pi never
needs internet — it can be fully offline.

- **Agent mode** — a chat UI where an LLM (your choice of Anthropic Claude, OpenAI, or Google
  Gemini, using **your own API key**) reasons about your goal and drives the shell for you,
  one command at a time. Every command and result is shown inline so you can follow — and stop
  — at any point. Conversations are saved on the phone so you can resume past sessions.
- **Shell mode** — a real interactive terminal (xterm.js), for when you just want to type.

Two halves, one wire protocol:

- **`murmurd`** — a Python daemon on the Pi that exposes a shell over a custom BLE GATT
  service. No compilation needed — just BlueZ and a venv.
- **murmur app** — a React Native (Expo) app for iOS and Android that connects to the Pi over
  BLE and hosts both modes.

The agent loop runs **on the phone**: the phone holds the API key and the internet connection,
calls the LLM, and ships the resulting commands to the Pi over BLE. The Pi only ever needs
Bluetooth.

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
docs/          design notes and the sample systemd unit
PROTOCOL.md    the wire protocol — single source of truth for both sides
```

## Security

`murmurd` runs the shell as a **non-root** user, and the sample systemd unit is hardened
(`NoNewPrivileges`, `ProtectSystem=strict`). The agent can run `sudo` — the app sends the
password over the encrypted link — **only if** the service is configured to permit privilege
escalation; the hardened default blocks it. See
[`daemon/README.md`](./daemon/README.md#privileges--sudo) for how (and the tradeoff: whoever
can pair a phone then effectively has root on the Pi).

API keys and the BLE pairing key never leave the phone's OS-level secure store (Keychain /
Keystore); murmur has no backend of its own, so the only thing that leaves the phone is the
LLM calls you make with your own key. See [`app/README.md`](./app/README.md#data--privacy).

## Status

Beta. The daemon and protocol are stress-tested via unit tests on both sides; the app has
shipped to TestFlight (iOS). Android BLE support is implemented but less exercised in
practice, and over-the-air JS updates aren't wired up yet (see
[`app/README.md`](./app/README.md)).

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
pnpm install        # or npm install
pnpm test           # protocol mirror round-trip tests (node --test)
```

See [`app/README.md`](./app/README.md) for running the app on a physical iPhone and building
with EAS.

## License

[MIT](./LICENSE)
