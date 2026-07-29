# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately using either:

- [GitHub private vulnerability reporting](https://github.com/nekonihq/murmur/security/advisories/new)
  (Security tab → "Report a vulnerability")
- Email **denys@malykhin.dev**

Include what you found, steps to reproduce, and the potential impact. We'll acknowledge
reports within a few days and keep you updated as we investigate and fix the issue.

## Scope

murmur is two components with different trust boundaries:

- **`murmurd`** (the Pi daemon) — exposes a shell over a custom BLE GATT service, authenticated
  by a pre-shared key (HMAC-SHA256 challenge/response, see [`PROTOCOL.md`](./PROTOCOL.md)).
  Runs as a non-root user by default; the sample systemd unit is hardened
  (`NoNewPrivileges`, `ProtectSystem=strict`). Optional `sudo` support is opt-in and
  documented as a deliberate trust trade-off — see
  [`daemon/README.md`](./daemon/README.md#privileges--sudo).
- **`murmur app`** — holds the BLE pairing key and any LLM API keys in the phone's OS-level
  secure store (Keychain/Keystore). Has no backend of its own — see [`PRIVACY.md`](./PRIVACY.md).

Vulnerabilities we're especially interested in:

- Anything that lets an unpaired device bypass the BLE auth handshake.
- Anything that lets a paired-but-unprivileged phone escalate beyond what the daemon's
  configured privilege level allows.
- Secret handling issues — PSK, LLM API keys, or sudo password exposure on disk, in logs,
  or over the wire.
- Issues in the framing/flow-control protocol that could crash the daemon or corrupt a
  session (see [`PROTOCOL.md`](./PROTOCOL.md)).

## Out of scope

- Attacks requiring physical access to an already-unlocked, paired phone.
- The documented trade-off of enabling `sudo` support (see linked docs above) — this is
  intentional and covered by design, not a vulnerability, as long as it behaves as documented.
- Issues in third-party dependencies without a demonstrated impact on murmur itself (report
  those upstream).

## Supported versions

murmur does not yet maintain multiple release branches — fixes land on `main` and the
latest release only.
