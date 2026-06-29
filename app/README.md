# murmur app

React Native (iOS + Android) client for murmur. Connects to `murmurd` over BLE and offers a
**Shell** tab (interactive terminal) and an **Agent** tab (LLM drives the shell with your own
API key).

## Source layout

```
src/
  protocol/     wire protocol mirror of daemon/src/protocol (frame.ts, messages.ts)
  crypto/       sha256 + hmac (auth) + base64 — dependency-free, RFC-vector tested
  ble/          react-native-ble-plx transport (transport.ts)
  client.ts     connection + auth handshake + sessions + flow-control credits
  agent/        provider-agnostic agent loop (loop.ts) + types
  providers/    Anthropic (default), OpenAI, Gemini adapters
  storage/      Keychain/Keystore for the BLE PSK and BYO API keys
  terminal/     xterm.js-in-WebView terminal
  screens/      Devices, Shell, Agent, Settings
  App.tsx       root + tab navigation
```

## Tests

The pure-logic modules (protocol, crypto, agent loop) run under Node 24's native TypeScript
support — no build step:

```sh
npm test     # node --test "src/**/*.test.ts"
```

These include a golden frame vector that must match the Rust daemon's encoding, and RFC 4231
HMAC vectors that guarantee the auth response matches what the daemon verifies.

## Running the app

This package contains the JS/TS source and config. Generate the native iOS/Android projects
once (they're git-ignored), then install JS deps:

```sh
# from a temporary RN template, or:
npx @react-native-community/cli init murmur --version 0.79.0
# copy this src/, index.js, app.json, babel.config.js, package.json over the template, then:
npm install
npm run ios       # or: npm run android
```

### Required native setup

- **iOS** (`Info.plist`): `NSBluetoothAlwaysUsageDescription` (and
  `NSBluetoothPeripheralUsageDescription`) — explain BLE use to the user.
- **Android** (`AndroidManifest.xml`): `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT` (API 31+), and
  location permission on older APIs; request them at runtime before scanning.

## Pairing

On the Pi: `murmurd --pair` prints a base64 key. In the app's Devices screen, pick your Pi and
paste that key once; it's stored in the device keychain and reused on every reconnect.

## Notes

- Imports use explicit `.ts`/`.tsx` extensions so Node's test runner resolves them; `tsconfig`
  sets `allowImportingTsExtensions` and RN's Metro resolves them too.
- The terminal loads xterm.js from a CDN (the phone has internet; only the Pi need not). For a
  fully offline app, vendor xterm into the bundle.
