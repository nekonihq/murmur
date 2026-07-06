# murmur app

**Expo (SDK 55) + expo-router + EAS** client for murmur. Connects to `murmurd` over BLE and
offers a **Shell** tab (interactive terminal) and an **Agent** tab (LLM drives the shell with
your own API key).

## Source layout

```
src/
  app/          expo-router routes:
                  _layout.tsx        Stack + ConnectionProvider
                  index.tsx          device scan/connect
                  pair.tsx           enter the PSK from `murmurd --pair`
                  (tabs)/_layout.tsx Shell / Agent / Settings tabs
                  (tabs)/{shell,agent,settings}.tsx
  ConnectionContext.tsx   active MurmurClient + provider, shared across tabs
  protocol/     TypeScript mirror of PROTOCOL.md (frame.ts, messages.ts)
  crypto/       sha256 + hmac (auth) + base64 — dependency-free, RFC-vector tested
  ble/          react-native-ble-plx transport (transport.ts)
  client.ts     connection + auth handshake + sessions + flow-control credits
  agent/        provider-agnostic agent loop (loop.ts) + types
  providers/    Anthropic (default), OpenAI, Gemini adapters
  storage/      expo-secure-store for the BLE PSK and BYO API keys
  terminal/     xterm.js-in-WebView terminal
  screens/      presentational Shell / Agent / Settings (consumed by routes)
  theme.ts      light + dark palettes (system default, user-overridable)
```

## Tests

The pure-logic modules (protocol, crypto, agent loop) run under Node 24's native TypeScript
support — no build step:

```sh
npm test     # node --test "src/**/*.test.ts"
```

These include a golden frame vector that must match the daemon's encoding, and RFC 4231
HMAC vectors that guarantee the auth response matches what the daemon verifies.

## Run locally on an iPhone

You need a **physical iPhone** and a **custom dev build** — not Expo Go (it can't load the
`react-native-ble-plx` native module) and not the iOS Simulator (the Simulator has **no
Bluetooth**). A free Apple ID is enough for signing; the build then expires after 7 days
(an Apple Developer account removes that limit).

**One-time prerequisites (macOS):**

```sh
xcode-select --install            # Xcode command-line tools (install Xcode from the App Store too)
brew install cocoapods watchman
```

**Build & install the dev client onto the phone:**

```sh
cd app
pnpm install            # or npm install
npx expo install        # pin native dep versions to the SDK

# Plug in + unlock the iPhone, tap "Trust", and enable
# Settings → Privacy & Security → Developer Mode (iOS 16+), then reboot.

npx expo run:ios --device   # prebuilds ios/, pod installs, compiles, installs, starts Metro
```

The first build usually stops on code signing. Set a team once:

```sh
open ios/murmur.xcworkspace
```

In Xcode → target **murmur** → **Signing & Capabilities** → enable *Automatically manage
signing* and pick your personal Apple ID team. If the bundle id `com.nekoni.murmur` is
rejected as taken, change it in `app.json` (e.g. `com.yourname.murmur`) and re-run. Then on
the phone trust the cert at **Settings → General → VPN & Device Management**.

**Day-to-day** (after the dev build is installed once):

```sh
npx expo start --dev-client     # open the "murmur" app on the phone; fast JS reload over Wi-Fi
```

Re-run `expo run:ios` only when native code or native deps change.

On first BLE scan iOS shows the Bluetooth permission prompt (from the config plugin's usage
string). Then point it at a running `murmurd` — see **Pairing** below.

> Prefer installing over the air, or building without a Mac? Use
> `npx eas build --profile development --platform ios` — but that needs a paid Apple Developer
> account to register the device for ad-hoc distribution. For one personal iPhone,
> `expo run:ios --device` is simplest.

## Build & publish (Expo + EAS)

Uses Expo's managed config with continuous native generation — there are no checked-in
`ios/`/`android/` folders; `expo prebuild` generates them. BLE needs a **dev build** (not
Expo Go), because `react-native-ble-plx` is a custom native module.

```sh
pnpm install                       # or npm install
npx expo install                   # align native dep versions to the SDK

# First-time EAS setup (fills extra.eas.projectId + the expo-updates URL):
npx eas init
npx eas update:configure

# Local dev build (creates a custom dev client with BLE compiled in):
npx expo run:ios                   # or: npx expo run:android
npx expo start --dev-client        # then reload JS against the dev build

# Cloud builds & store submission via EAS (profiles in eas.json):
npx eas build --profile development --platform ios
npx eas build --profile preview    --platform android
npx eas build --profile production
npx eas submit  --profile production

# OTA JS updates (expo-updates):
npx eas update --branch production
```

BLE permissions are declared in `app.json` (the `react-native-ble-plx` config plugin adds the
iOS `NSBluetoothAlwaysUsageDescription` and the Android `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT`
entries during prebuild) — no manual `Info.plist`/`AndroidManifest.xml` editing.

> `app.json` ships without `extra.eas.projectId` / `updates.url`; `eas init` +
> `eas update:configure` add them for your EAS project.

## Pairing

On the Pi: `murmurd --pair` prints a base64 key. In the app's Devices screen, pick your Pi and
paste that key once; it's stored in the device keychain and reused on every reconnect.

## Notes

- Imports use explicit `.ts`/`.tsx` extensions so Node's test runner resolves them; `tsconfig`
  sets `allowImportingTsExtensions` and RN's Metro resolves them too.
- The terminal loads xterm.js from a CDN (the phone has internet; only the Pi need not). For a
  fully offline app, vendor xterm into the bundle.
