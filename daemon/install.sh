#!/usr/bin/env bash
# murmurd installer — sets up the murmur daemon on a Raspberry Pi (or any
# Debian/apt Linux host with BlueZ). Safe to re-run (idempotent).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/nekonihq/murmur/main/daemon/install.sh | bash
#
# What it does:
#   - installs bluez + build deps via apt
#   - creates a non-root 'murmur' system user in the 'bluetooth' group
#   - clones/updates the murmur repo into /opt/murmur
#   - installs uv and runs `uv sync` in daemon/ (pinned by uv.lock)
#   - installs the hardened systemd unit (not enabled — you start it yourself)
#
# It does NOT pair a phone or start the service — see the printed next steps.

set -euo pipefail

REPO_URL="${MURMUR_REPO_URL:-https://github.com/nekonihq/murmur.git}"
REPO_REF="${MURMUR_REPO_REF:-main}"
INSTALL_DIR="${MURMUR_INSTALL_DIR:-/opt/murmur}"
SERVICE_USER="${MURMUR_USER:-murmur}"
CONFIG_DIR="/home/${SERVICE_USER}/.config/murmur"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "murmurd targets Linux/BlueZ — this host isn't Linux."
command -v apt-get >/dev/null 2>&1 || die "this installer needs apt (Raspberry Pi OS / Debian / Ubuntu / Kali). See daemon/README.md for a manual install."
command -v systemctl >/dev/null 2>&1 || die "systemd is required (murmurd ships a systemd unit)."

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "run this as root, or install sudo first."
  SUDO="sudo"
fi

log "Installing system packages (bluez, build tools, dbus headers, git)..."
$SUDO apt-get update -y
$SUDO apt-get install -y bluez python3-dev build-essential libdbus-1-dev pkg-config git

log "Enabling bluetoothd..."
$SUDO systemctl enable --now bluetooth

# ≤512MB RAM + no swap + 32-bit: dbus-fast (a bless dependency) has no
# prebuilt wheel there and its source build can get OOM-killed. See
# daemon/README.md → "Low-RAM boards" for the fix; just warn here.
ARCH="$(uname -m)"
TOTAL_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
SWAP_KB="$(awk '/SwapTotal/ {print $2}' /proc/meminfo)"
if [[ "$ARCH" == "armv7l" && "$SWAP_KB" -eq 0 && "$TOTAL_KB" -le 524288 ]]; then
  warn "32-bit board, ≤512MB RAM, no swap — the dependency build below may get"
  warn "OOM-killed. Add a swapfile first; see daemon/README.md 'Low-RAM boards'."
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user '${SERVICE_USER}'..."
  $SUDO useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
fi
$SUDO usermod -aG bluetooth "$SERVICE_USER"

# Git ops run as $SERVICE_USER (not root) so ownership of $INSTALL_DIR stays
# consistent across runs — git refuses to operate on a repo owned by a
# different user ("detected dubious ownership"), which would break the
# update path on every run after the first.
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  log "Updating existing checkout at ${INSTALL_DIR}..."
  $SUDO chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"
  $SUDO -u "$SERVICE_USER" git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_REF"
  $SUDO -u "$SERVICE_USER" git -C "$INSTALL_DIR" checkout "$REPO_REF"
  $SUDO -u "$SERVICE_USER" git -C "$INSTALL_DIR" reset --hard "origin/${REPO_REF}"
else
  log "Cloning murmur into ${INSTALL_DIR}..."
  $SUDO mkdir -p "$INSTALL_DIR"
  $SUDO chown "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"
  $SUDO -u "$SERVICE_USER" git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
fi

UV_BIN="/home/${SERVICE_USER}/.local/bin/uv"
if [[ ! -x "$UV_BIN" ]]; then
  log "Installing uv for ${SERVICE_USER}..."
  $SUDO -u "$SERVICE_USER" sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
fi

log "Syncing daemon dependencies (uv sync, pinned by uv.lock)..."
$SUDO -u "$SERVICE_USER" sh -c "cd '${INSTALL_DIR}/daemon' && '${UV_BIN}' sync"

log "Installing the systemd unit (not enabled yet)..."
$SUDO install -m 644 "${INSTALL_DIR}/docs/murmurd.service" /etc/systemd/system/murmurd.service
$SUDO systemctl daemon-reload

cat <<EOF

Installed. murmurd runs as the non-root '${SERVICE_USER}' user; sudo is
disabled for the agent until you opt in (see daemon/README.md → "Privileges
& sudo").

Next steps:

  1. Pair a phone (prints a base64 key — paste it into the app once):

       sudo -u ${SERVICE_USER} ${INSTALL_DIR}/daemon/.venv/bin/murmurd \\
            --config-dir ${CONFIG_DIR} --pair

  2. Start the service:

       sudo systemctl enable --now murmurd

  3. Check it's alive:

       sudo systemctl status murmurd
       bluetoothctl -- show   # confirm the adapter is powered/advertising

EOF
