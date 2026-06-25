#!/usr/bin/env bash
# Bootstrap a fresh VM (Debian/Ubuntu) to run the hermes launcher.
#
# Usage on the target VM (as root):
#   curl -L https://raw.githubusercontent.com/duckhoa-uit/hermes-control-plane/main/infra/launcher/install.sh | sudo bash
#
# Or after cloning:
#   sudo bash infra/launcher/install.sh
#
# What it does:
#   1. Creates a 'hermes' system user.
#   2. Installs bun for that user.
#   3. Lays down /opt/hermes and /etc/hermes with correct perms.
#   4. Installs the systemd unit. Does NOT enable/start it — you must
#      drop /etc/hermes/launcher.env and /etc/hermes/app.pkcs8.pem first.
#
# After running this, do (still as root):
#   cp infra/launcher/env.example /etc/hermes/launcher.env
#   chmod 600 /etc/hermes/launcher.env
#   chown hermes:hermes /etc/hermes/launcher.env
#   $EDITOR /etc/hermes/launcher.env   # paste real secrets
#   cp /path/to/app.pkcs8.pem /etc/hermes/app.pkcs8.pem
#   chmod 600 /etc/hermes/app.pkcs8.pem
#   chown hermes:hermes /etc/hermes/app.pkcs8.pem
#
#   # Build the launcher bundle on a dev machine and copy:
#   #   bun build src/launcher/server.ts --target=bun --outfile dist/launcher.js
#   #   scp dist/launcher.js root@vm:/opt/hermes/launcher.js
#   chown hermes:hermes /opt/hermes/launcher.js
#
#   systemctl daemon-reload
#   systemctl enable --now hermes-launcher
#   journalctl -u hermes-launcher -f

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script must run as root (it creates a system user)." >&2
  exit 1
fi

if ! command -v curl >/dev/null; then
  apt-get update -y
  apt-get install -y curl ca-certificates unzip
fi

# 1. hermes user
if ! id -u hermes >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin hermes
  echo "[install] created hermes user"
else
  echo "[install] hermes user already exists"
fi

# 2. bun for hermes
if [[ ! -x /home/hermes/.bun/bin/bun ]]; then
  sudo -u hermes -H bash -c 'curl -fsSL https://bun.sh/install | bash'
  echo "[install] installed bun for hermes"
fi
/home/hermes/.bun/bin/bun --version

# 3. layout
install -d -o hermes -g hermes -m 0750 /opt/hermes
install -d -o hermes -g hermes -m 0750 /etc/hermes

# 4. systemd unit
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/hermes-launcher.service" ]]; then
  install -m 0644 "$SCRIPT_DIR/hermes-launcher.service" /etc/systemd/system/hermes-launcher.service
  echo "[install] installed /etc/systemd/system/hermes-launcher.service"
else
  echo "[install] WARN: hermes-launcher.service not next to this script; copy it manually."
fi

echo
echo "Next steps:"
echo "  1. Drop /etc/hermes/launcher.env (see infra/launcher/env.example)"
echo "  2. Drop /etc/hermes/app.pkcs8.pem (your GitHub App private key)"
echo "  3. scp the launcher bundle to /opt/hermes/launcher.js"
echo "  4. systemctl daemon-reload && systemctl enable --now hermes-launcher"
echo "  5. journalctl -u hermes-launcher -f"
