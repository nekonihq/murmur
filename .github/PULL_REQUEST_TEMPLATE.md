## What

<!-- What does this change, and why? Link related issues with "Fixes #123" if applicable. -->

## Component

- [ ] App (iOS)
- [ ] Daemon (`murmurd` on the Pi)
- [ ] Protocol (`PROTOCOL.md` + both mirrors)
- [ ] Docs only

## Testing

<!-- CI can't exercise real BLE hardware, so tell us what you actually ran. -->

- [ ] `daemon`: `python3 -m unittest discover -s tests -t .` passes
- [ ] `app`: `pnpm test` and `pnpm typecheck` pass
- [ ] Tested against real hardware (Pi model / OS, phone / OS version):

## Protocol changes

<!-- Delete this section if not applicable. -->

- [ ] `PROTOCOL.md` updated
- [ ] `daemon/murmurd/protocol.py` and `app/src/protocol/` kept byte-compatible

## Checklist

- [ ] I've read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] This PR is focused on one change (no unrelated cleanup bundled in)
