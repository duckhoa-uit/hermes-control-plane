#!/usr/bin/env bash
# One-shot setup for hermes-launcher on a Debian/Ubuntu VPS that already
# runs your Hermes agent.
#
# Run as root:
#   sudo bash infra/launcher/install.sh
#
# What it does (idempotent):
#   1. apt deps + bun + cloudflared
#   2. hermes-cp system user + /opt/hermes-control-plane + /etc/hermes-control-plane
#   3. clones (or pulls) this repo into /opt/hermes-control-plane/src
#   4. builds dist/launcher.js into /opt/hermes-control-plane/launcher.js
#   5. installs systemd unit (does NOT start it)
#   6. prompts you for secrets if /etc/hermes-control-plane/launcher.env doesn't exist
#   7. prints next steps for cloudflared + Worker secret
#
# After this script:
#   - sudo systemctl start hermes-launcher
#   - sudo journalctl -u hermes-launcher -f
#   - then run the cloudflared section at the bottom of the script's
#     final output

set -euo pipefail

REPO_URL="${HERMES_REPO_URL:-https://github.com/duckhoa-uit/hermes-control-plane.git}"
REPO_REF="${HERMES_REPO_REF:-main}"
SRC_DIR="/opt/hermes-control-plane/src"
HERMES_USER="hermes-cp"

log() { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root (creates a system user)"

# -------- 1. apt deps --------
log "installing apt deps"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates git unzip systemd

# -------- 2. hermes user --------
if id -u "$HERMES_USER" >/dev/null 2>&1; then
  log "$HERMES_USER user already exists"
else
  log "creating $HERMES_USER user"
  useradd --system --create-home --shell /bin/bash "$HERMES_USER"
fi

# -------- 3. bun for hermes --------
if [[ ! -x "/home/$HERMES_USER/.bun/bin/bun" ]]; then
  log "installing bun for $HERMES_USER"
  sudo -u "$HERMES_USER" -H bash -c 'curl -fsSL https://bun.sh/install | bash'
fi
"/home/$HERMES_USER/.bun/bin/bun" --version

# -------- 4. cloudflared --------
if command -v cloudflared >/dev/null; then
  log "cloudflared already installed: $(cloudflared --version | head -1)"
else
  log "installing cloudflared"
  ARCH="$(dpkg --print-architecture)"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" \
    -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  rm /tmp/cloudflared.deb
fi

# -------- 5. layout --------
log "creating /opt/hermes-control-plane and /etc/hermes-control-plane"
install -d -o "$HERMES_USER" -g "$HERMES_USER" -m 0750 /opt/hermes-control-plane
install -d -o "$HERMES_USER" -g "$HERMES_USER" -m 0750 /etc/hermes-control-plane

# -------- 6. clone / pull --------
if [[ -d "$SRC_DIR/.git" ]]; then
  log "pulling $REPO_REF in $SRC_DIR"
  sudo -u "$HERMES_USER" git -C "$SRC_DIR" fetch --depth 1 origin "$REPO_REF"
  sudo -u "$HERMES_USER" git -C "$SRC_DIR" reset --hard "FETCH_HEAD"
else
  log "cloning $REPO_URL @ $REPO_REF into $SRC_DIR"
  sudo -u "$HERMES_USER" git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SRC_DIR"
fi

# -------- 7. build launcher.js --------
log "installing dependencies + building launcher bundle"
sudo -u "$HERMES_USER" -H bash -c "
  export PATH=/home/$HERMES_USER/.bun/bin:\$PATH
  cd $SRC_DIR
  bun install --frozen-lockfile
  bun build src/launcher/server.ts --target=bun --outfile dist/launcher.js
"
install -o "$HERMES_USER" -g "$HERMES_USER" -m 0644 \
  "$SRC_DIR/dist/launcher.js" /opt/hermes-control-plane/launcher.js
log "wrote /opt/hermes-control-plane/launcher.js"

# -------- 8. systemd unit --------
install -m 0644 \
  "$SRC_DIR/infra/launcher/hermes-launcher.service" \
  /etc/systemd/system/hermes-launcher.service
systemctl daemon-reload
log "installed /etc/systemd/system/hermes-launcher.service"

# -------- 9. env file (interactive only if missing) --------
ENV_FILE=/etc/hermes-control-plane/launcher.env
if [[ -f "$ENV_FILE" ]]; then
  log "$ENV_FILE already present — not overwriting"
else
  install -m 0600 -o "$HERMES_USER" -g "$HERMES_USER" \
    "$SRC_DIR/infra/launcher/env.example" "$ENV_FILE"
  warn "wrote $ENV_FILE from env.example — EDIT IT NOW with real secrets:"
  warn "  sudo nano $ENV_FILE"
fi

# -------- 10. final report --------
cat <<MSG

────────────────────────────────────────────────────────────────────
✅  hermes-launcher install done.

Next steps (manual — secrets and Cloudflare cannot be automated):

1.  Drop real secrets in $ENV_FILE:
      sudo nano $ENV_FILE

2.  Start the launcher:
      sudo systemctl enable --now hermes-launcher
      sudo journalctl -u hermes-launcher -f
    Expect:
      [launcher] hermes-launcher listening on http://localhost:8789

3.  Smoke-test from the same VPS (Hermes will use this URL):
      curl http://localhost:8789/health

4.  Expose port 8789 to the Worker via Cloudflare Tunnel:
      cloudflared tunnel login
      cloudflared tunnel create hermes-launcher
      cloudflared tunnel route dns hermes-launcher launcher.<your-domain>
      # write /etc/cloudflared/config.yml — see infra/launcher/README.md §3
      sudo cloudflared service install <tunnel-token>

5.  Set the Worker secret (from your dev machine):
      echo "https://launcher.<your-domain>" | bun x wrangler secret put HERMES_LAUNCHER_URL
      bun run deploy

6.  Wire Hermes Agent to the MCP server + skill. Edit ~/.hermes/config.yaml:

      mcp_servers:
        hermes-control-plane:
          url: "http://localhost:8789/mcp"
          timeout: 300
      skills:
        external_dirs:
          - $SRC_DIR/skills

    Then restart Hermes. Full runbook: infra/mcp/README.md.

────────────────────────────────────────────────────────────────────
MSG
