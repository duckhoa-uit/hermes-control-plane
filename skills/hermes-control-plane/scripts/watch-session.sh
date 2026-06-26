#!/usr/bin/env bash
# watch-session.sh — poll a Hermes Control Plane session every 5s and
# print a one-line summary per change. Exits 0 on `completed`, 1 on
# `failed` / `aborted`, 2 on transport error.
#
# Usage:
#   watch-session.sh <sessionId> [worker_url]
#
# Defaults to the launcher's WORKER_URL passthrough on
# http://localhost:8787 — pass the deployed Worker URL otherwise.
#
# This is the recommended fallback when the host platform cannot hold
# the WebSocket `streamUrl` open. The output is parseable: each line
# is `<unix_ts> <status> events=<n> [pr=<url>] [err=<message>]`.

set -euo pipefail

SESSION_ID="${1:?usage: watch-session.sh <sessionId> [worker_url]}"
WORKER_URL="${2:-${HERMES_WORKER_URL:-http://localhost:8787}}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"

last_signature=""
while true; do
  body="$(curl -fsS "${WORKER_URL}/sessions/${SESSION_ID}" 2>/dev/null || true)"
  if [[ -z "$body" ]]; then
    echo "$(date +%s) transport_error" >&2
    exit 2
  fi

  status="$(printf '%s' "$body" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["session"]["status"])')"
  events="$(printf '%s' "$body" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d.get("events",[])))')"
  pr_url="$(printf '%s' "$body" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("artifacts",{}).get("prUrl",""))')"
  err_msg="$(printf '%s' "$body" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["session"].get("errorMessage",""))')"

  signature="${status}|${events}|${pr_url}|${err_msg}"
  if [[ "$signature" != "$last_signature" ]]; then
    line="$(date +%s) ${status} events=${events}"
    [[ -n "$pr_url" ]] && line="${line} pr=${pr_url}"
    [[ -n "$err_msg" ]] && line="${line} err=\"${err_msg}\""
    echo "$line"
    last_signature="$signature"
  fi

  case "$status" in
    completed) exit 0 ;;
    failed|aborted) exit 1 ;;
    archived) exit 1 ;;
  esac

  sleep "$POLL_INTERVAL"
done
