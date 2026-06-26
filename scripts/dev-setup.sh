#!/usr/bin/env bash
# Single-command bootstrap for hermes-control-plane local dev.
#
# Run from a fresh clone:
#
#     bash scripts/dev-setup.sh
#
# Or, when bun is already on PATH:
#
#     ./scripts/dev-setup.sh
#
# What it does (in order, fail-fast on each step):
#
#   1. Verify bun (>=1.3) and node (>=22) are installed; print install hints
#      if not.
#   2. bun install --frozen-lockfile (uses lockfile, installs husky hook).
#   3. Verify the toolchain works: lint + format-check + typecheck + tests.
#   4. If .dev.vars does not exist yet, copy from .dev.vars.example and
#      print exactly which env vars still need to be filled in.
#   5. Print the next-step commands (`bun run dev`, `bun run launcher`,
#      `bun run e2e:full ...`).
#
# Idempotent — safe to re-run.
# ----------------------------------------------------------------------

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bold=$'\033[1m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
step() { printf "\n%s▸ %s%s\n" "$bold" "$1" "$reset"; }
ok()   { printf "  %s✓%s %s\n" "$green" "$reset" "$1"; }
warn() { printf "  %s!%s %s\n" "$yellow" "$reset" "$1"; }
die()  { printf "  %s✗%s %s\n" "$red" "$reset" "$1"; exit 1; }

# ---- 1. Tooling check ------------------------------------------------------
step "1/5 Tooling check"

if ! command -v bun >/dev/null 2>&1; then
  die "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
fi
BUN_VER=$(bun --version)
ok "bun $BUN_VER"

if ! command -v node >/dev/null 2>&1; then
  warn "node not found. wrangler dev needs node 22+ for nodejs_compat."
  warn "Install: https://nodejs.org or via fnm/nvm"
else
  NODE_VER=$(node --version)
  ok "node $NODE_VER"
fi

if ! command -v wrangler >/dev/null 2>&1 && ! bunx --bun wrangler --version >/dev/null 2>&1; then
  warn "wrangler not on PATH. We use 'bunx wrangler' so this is fine; install"
  warn "globally with 'npm i -g wrangler' if you want the bare command."
else
  ok "wrangler available (via bunx)"
fi

# ---- 2. Install ------------------------------------------------------------
step "2/5 Install dependencies"
bun install --frozen-lockfile
ok "bun install done (lockfile pinned)"

# ---- 3. Sanity gates -------------------------------------------------------
step "3/5 Sanity gates"
bun run lint
ok "lint clean"
bun run format:check >/dev/null
ok "format clean"
bun run typecheck
ok "typecheck clean"
bun run test
ok "vitest suite clean"

# ---- 4. .dev.vars ----------------------------------------------------------
step "4/5 Environment file"
if [[ -f .dev.vars ]]; then
  ok ".dev.vars already exists (not overwritten)"
else
  cp .dev.vars.example .dev.vars
  ok "copied .dev.vars.example -> .dev.vars"
fi

missing=()
while IFS= read -r line; do
  # Skip comments / blanks.
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue
  key="${line%%=*}"
  val="${line#*=}"
  if [[ -z "${val// }" ]]; then
    missing+=("$key")
  fi
done < .dev.vars

if (( ${#missing[@]} > 0 )); then
  warn "the following .dev.vars values are blank — fill in before running e2e:"
  for k in "${missing[@]}"; do
    printf "      - %s\n" "$k"
  done
else
  ok "all .dev.vars values present"
fi

# ---- 5. Next steps ---------------------------------------------------------
step "5/5 Next steps"
cat <<'EOF'
  Local dev:
    Terminal A:  set -a && source .dev.vars && set +a && bunx wrangler dev
    Terminal B:  set -a && source .dev.vars && set +a && bun run launcher
    Terminal C:  ngrok http 8787   # only if running real e2e

  Smoke test (no external creds):
    bun run test         # vitest suite
    bun run bundle:size  # check the Worker bundle stays under budget

  Real e2e against a throwaway GitHub repo:
    bun run e2e:full --repo https://github.com/<you>/<throwaway>

  Full docs: docs/SETUP.md  |  docs/DEPLOYMENT.md  |  CONTRIBUTING.md
EOF
echo
ok "ready"
