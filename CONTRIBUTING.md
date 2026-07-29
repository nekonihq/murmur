# Contributing to murmur

## Layout

```
daemon/        Python daemon (murmurd) — runs on the Pi
app/           React Native / Expo app (iOS + Android)
docs/          design notes and the sample systemd unit
PROTOCOL.md    the wire protocol — single source of truth for both sides
```

`PROTOCOL.md` is authoritative: if you change framing, auth, or message shapes, update it
first and keep `daemon/murmurd/protocol.py` and `app/src/protocol/` byte-compatible. Both
sides carry the same golden frame vectors and RFC 4231 HMAC vectors precisely so they can't
drift silently — a protocol change isn't done until both test suites pass.

## Daemon (`daemon/`)

No pip install needed to run the tests — protocol, auth, flow-control, exec, and config logic
are stdlib-only:

```sh
cd daemon
python3 -m unittest discover -s tests -t .
```

For anything that touches `ble.py` (the BlueZ GATT peripheral), you'll need a real adapter —
those tests are integration glue, not covered by the unit suite.

If you change dependencies in `pyproject.toml`, regenerate the lockfile and commit it:

```sh
uv lock
```

## App (`app/`)

```sh
cd app
pnpm install
pnpm test        # protocol mirror round-trip tests (node --test)
pnpm typecheck
```

If you change `package.json` dependencies, regenerate and commit `pnpm-lock.yaml` so it stays
in sync.

To run on a physical device (native code changed):

```sh
npx expo run:ios --device
```

## Security-sensitive areas

- `daemon/murmurd/auth.py` — the HMAC challenge/response handshake.
- `daemon/murmurd/session.py` — sudo/askpass plumbing (see
  [`daemon/README.md`](./daemon/README.md#privileges--sudo) for the threat model).
- `docs/murmurd.service` — the hardened systemd unit. Don't loosen `NoNewPrivileges` /
  `ProtectSystem` / `ProtectHome` in the shipped default; that's an explicit opt-in step
  documented for users, not something to relax upstream.

Changes here get closer scrutiny than everywhere else in the repo.

## Pull requests

- Keep the PR focused — one change, one purpose. Don't bundle unrelated cleanup.
- Explain the *why* in the PR description; the diff already shows the *what*.
- Note any manual testing you did (which OS/board for daemon changes, which iOS/Android
  version for app changes) since CI can't exercise real BLE hardware.

## License

By contributing, you agree your changes are licensed under the project's [MIT license](./LICENSE).
