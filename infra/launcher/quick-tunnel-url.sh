#!/usr/bin/env bash
# Print the current TryCloudflare URL for the control-plane-launcher quick
# tunnel. Greps journald for the most recent
# "https://<random>.trycloudflare.com" line emitted by cloudflared.
#
# Usage:
#   /opt/hermes-control-plane/quick-tunnel-url.sh
#   /opt/hermes-control-plane/quick-tunnel-url.sh --wait 60   # block up to 60s
set -euo pipefail

WAIT=0
if [[ "${1:-}" == "--wait" ]]; then
  WAIT="${2:-30}"
fi

extract_url() {
  journalctl -u control-plane-quick-tunnel.service --no-pager -o cat 2>/dev/null \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
    | tail -1
}

url="$(extract_url || true)"
if [[ -z "$url" && "$WAIT" -gt 0 ]]; then
  for _ in $(seq 1 "$WAIT"); do
    sleep 1
    url="$(extract_url || true)"
    [[ -n "$url" ]] && break
  done
fi

if [[ -z "$url" ]]; then
  echo "no trycloudflare URL found in journald — is control-plane-quick-tunnel.service running?" >&2
  exit 1
fi
echo "$url"
