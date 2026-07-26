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

**Quick install** — one command does the apt deps, the non-root `murmur` user, `uv sync`,
and the systemd unit (installed but not enabled/started, so you review before it runs):

```sh
curl -fsSL https://raw.githubusercontent.com/nekonihq/murmur/main/daemon/install.sh | bash
```

It's [`install.sh`](./install.sh) in this directory — read it before piping it into `bash` on
a box you care about, same as any installer script. Safe to re-run (it updates the checkout
and re-syncs deps). Needs apt + systemd (Raspberry Pi OS, Debian, Ubuntu, Kali); on anything
else, or if you'd rather see each step, follow the manual install below.

### Manual install

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

> **Careful mixing this with the systemd service.** The commands above pair under
> `~/.config/murmur` — i.e. whatever user you happen to be logged in as. The systemd unit
> instead runs as a dedicated `murmur` user with a hardcoded `--config-dir
> /home/murmur/.config/murmur`. Those are two different files with two different keys. If you
> pair manually as yourself and then start (or already run) the service, the app ends up
> holding a key the running daemon never sees, and every connection fails with `auth failed:
> bad MAC` no matter how many times you re-pair or restart — because you're re-pairing the
> wrong file. If you're installing the service, pair as the `murmur` user into its exact config
> dir instead:
>
> ```sh
> sudo -u murmur /opt/murmur/daemon/.venv/bin/murmurd \
>      --config-dir /home/murmur/.config/murmur --pair
> ```
>
> The PSK the daemon uses is also fixed at process startup — it isn't re-read from disk while
> running, so `sudo systemctl restart murmurd` after (re-)pairing.

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

## Privileges & sudo

`murmurd` runs the shell as a **non-root** user by design (the sample
[`../docs/murmurd.service`](../docs/murmurd.service) uses a dedicated `murmur` user). The
protocol carries an optional `sudo_password` (see [`../PROTOCOL.md`](../PROTOCOL.md)) and the
daemon feeds it to `sudo` through an askpass helper, so the agent *can* run privileged
commands — **but only if the service is configured to allow it.** The hardened unit
deliberately blocks privilege escalation.

If `sudo` fails with "operation not permitted" or never actually elevates, the cause is the
unit's hardening, in this order:

1. **`NoNewPrivileges=true`** — sets the kernel `no_new_privs` bit, which is inherited by every
   child and can't be cleared. `sudo` is setuid-root; under `no_new_privs`, `execve` of a
   setuid binary does **not** grant root, so sudo can never elevate. This is the hard blocker.
2. **`ProtectSystem=strict` / `ProtectHome=read-only`** — even once sudo can elevate, most of
   the filesystem is read-only for the whole service (children included), so privileged
   *writes* still fail.
3. **No sudoers entry** — the `murmur` system user isn't in `sudo`/`admin`, so it isn't
   authorized regardless.

To allow sudo, edit `/etc/systemd/system/murmurd.service` — in the `# Hardening` block remove
`NoNewPrivileges=true` and relax the filesystem protections:

```ini
ProtectSystem=no
ProtectHome=no
PrivateTmp=true
```

authorize the user (password-gated — the app supplies the password you set in Settings):

```sh
echo 'murmur ALL=(ALL:ALL) ALL' | sudo tee /etc/sudoers.d/murmur
sudo chmod 0440 /etc/sudoers.d/murmur
sudo visudo -cf /etc/sudoers.d/murmur        # validate syntax
```

then reload, restart, and set the **sudo password** in the app's Settings:

```sh
sudo systemctl daemon-reload
sudo systemctl restart murmurd
```

> **Security:** enabling sudo means anyone who can pair a phone (i.e. holds the PSK)
> effectively has **root** on the Pi. Only do this where that's acceptable. For passwordless
> sudo, use `NOPASSWD:ALL` in the sudoers line instead — simpler, but strictly more
> permissive. To keep some sandboxing, the one mandatory change is dropping
> `NoNewPrivileges=true`; you can leave `ProtectSystem=strict` and whitelist specific writable
> dirs with `ReadWritePaths=` instead.

## Notes

- `--pair` works without `bless` installed (the BLE import is deferred), so you can generate a
  key on any machine.
- If GATT registration or advertising fails on the Pi, enable BlueZ experimental features:
  add `--experimental` to `bluetoothd`'s `ExecStart` (or `Experimental = true` in
  `/etc/bluetooth/main.conf`), then `sudo systemctl restart bluetooth`.
- Run as a non-root user in the `bluetooth` group; the daemon spawns the shell as that user.
  See **Privileges & sudo** above to let the agent run privileged commands.
