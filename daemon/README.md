# murmurd (Python)

The murmur daemon. Exposes an interactive shell and a one-shot command runner over a custom
BLE GATT service. The AI agent loop lives on the phone; this daemon only executes what the
phone sends.

Python was chosen so the Pi needs **no compilation** — just BlueZ and a venv.

## Layout

```
murmurd/
  protocol.py   wire protocol — byte-compatible with app/src/protocol
  messages*     (payloads are plain JSON dicts; see PROTOCOL.md)
  auth.py       HMAC-SHA256 challenge/response over a pre-shared key
  conn.py       auth handshake + credit-based outbound flow-control pump
  session.py    pty session (shell mode) + exec runner (agent mode) + dispatcher
  config.py     PSK persistence (0600) + pairing
  ble.py        BlueZ GATT peripheral via `bless` (Linux-only; needs a real adapter)
  __main__.py   CLI (python -m murmurd)
tests/          stdlib unittest — run anywhere, no pip needed
```

## Tests

The protocol, auth, flow-control, exec, and config logic are unit-tested with the standard
library (no dependencies):

```sh
cd daemon
python3 -m unittest discover -s tests -t .
# or, if you use uv: uv run python -m unittest discover -s tests -t .
```

The tests need no dependencies, so plain `python3` works without installing anything. These
include a golden frame vector that must match the TypeScript app, and RFC 4231 HMAC vectors
that guarantee the auth response matches what the app sends. The `ble.py` layer is integration
glue that requires a real BlueZ adapter to validate.

## Dependencies & lockfile

`pyproject.toml` declares the deps (just `bless`); `uv.lock` pins the exact resolved versions
(with hashes) for reproducible installs. Regenerate the lock after changing dependencies:

```sh
cd daemon
uv lock        # updates uv.lock (uv sync does this implicitly if the lock is missing)
```

Commit `uv.lock`.

## Install on a Raspberry Pi

System prerequisites either way:

```sh
sudo apt install -y bluez python3-dev build-essential libdbus-1-dev pkg-config
sudo systemctl enable --now bluetooth
```

**With uv (recommended — uses the lockfile):**

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh    # if uv isn't installed
cd daemon
uv sync                                            # creates .venv from uv.lock (+ murmurd console script)

# Pair (prints a base64 key to paste into the app), then run:
uv run murmurd --config-dir ~/.config/murmur --pair
uv run murmurd --config-dir ~/.config/murmur --shell /bin/bash
# (or call .venv/bin/murmurd directly — same binary, no uv needed at runtime)
```

**Without uv (stdlib venv fallback — no extra tooling):**

```sh
sudo apt install -y python3-venv
cd daemon
python3 -m venv .venv
.venv/bin/pip install .          # resolves from pyproject (no lock pinning)
.venv/bin/murmurd --config-dir ~/.config/murmur --pair
.venv/bin/murmurd --config-dir ~/.config/murmur --shell /bin/bash
```

Either way you end up with `.venv/bin/murmurd`. For a hardened service, see
[`../docs/murmurd.service`](../docs/murmurd.service).

> Note: `uv` does not avoid the `dbus-fast` source compile on 32-bit boards — that's about
> prebuilt-wheel availability, not the installer. See the low-RAM section below.

### Low-RAM boards (Pi Zero / Zero 2 W) and Kali Linux

`bless` pulls in `dbus-fast`, which has a small native (Cython) extension. On `aarch64` with
an up-to-date pip it installs from a prebuilt wheel and there's nothing to compile. But:

- On **32-bit** images (`uname -m` → `armv7l`) there's often no prebuilt wheel — **Kali ARM
  in particular has no piwheels** (that's Raspberry Pi OS only) — so `dbus-fast` compiles from
  source.
- A boards with **≤512 MB RAM and no swap** (e.g. Pi Zero 2 W ships with `Swap: 0B`) will
  get the compile **OOM-killed** — it looks like a hang with the activity LED blinking.

Fixes, in order of preference:

```sh
uname -m        # aarch64 -> prefer the wheel path; armv7l -> you'll compile

# Path A (aarch64): skip the compile entirely
.venv/bin/pip install -U pip setuptools wheel && .venv/bin/pip install .

# Path B (must compile): add swap first so the build doesn't get OOM-killed
sudo fallocate -l 1G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=1024
sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab    # persist across reboots
.venv/bin/pip install .                                       # now completes (a few min on SD)
```

The compile is a one-time cost — pip caches the wheel for later installs.

## Notes

- `--pair` works without `bless` installed (the BLE import is deferred), so you can generate a
  key on any machine.
- If GATT registration or advertising fails on the Pi, enable BlueZ experimental features:
  add `--experimental` to `bluetoothd`'s `ExecStart` (or `Experimental = true` in
  `/etc/bluetooth/main.conf`), then `sudo systemctl restart bluetooth`.
- Run as a non-root user in the `bluetooth` group; the daemon spawns the shell as that user.
