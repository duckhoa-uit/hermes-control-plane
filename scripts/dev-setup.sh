#!/usr/bin/env bash
# Single-command bootstrap for Control Plan local dev.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
bold=$'\033[1m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
step() { printf "\n%s▸ %s%s\n" "$bold" "$1" "$reset"; }
ok()   { printf "  %s✓%s %s\n" "$green" "$reset" "$1"; }
die()  { printf "  %s✗%s %s\n" "$red" "$reset" "$1"; exit 1; }

step "1/4 Tooling check"
command -v bun >/dev/null 2>&1 || die "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
ok "bun $(bun --version)"
ok "node $(node --version)"

step "2/4 Install dependencies"
bun install --frozen-lockfile && ok "bun install done"

step "3/4 Sanity gates"
bun run lint && ok "lint clean"
bun run typecheck && ok "typecheck clean"
bun run test && ok "tests pass"

step "4/4 Environment file"
if [[ ! -f .dev.vars ]]; then
  cp .dev.vars.example .dev.vars && ok "copied .dev.vars.example -> .dev.vars"
else
  ok ".dev.vars exists"
fi

echo ""
echo "Next steps:"
echo "  bun run dev              # wrangler dev on port 8787"
echo "  npx flue build --target cloudflare"
echo "  npx wrangler deploy"
echo ""
ok "ready"
