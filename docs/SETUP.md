# Setup Guide

## Prerequisites

- bun 1.3+
- Node.js 22.18+ (for Flue CLI)
- Cloudflare account (Workers Paid for DO + Containers)
- wrangler CLI: `npm i -g wrangler`
- GitHub fine-grained PAT with Contents + Pull-requests RW

## Quick start

```bash
bun install
bun run test         # 140+ tests
bun run typecheck    # tsc --noEmit

# Local dev
npx flue build --target cloudflare
npx wrangler dev

# Deploy
npx flue build --target cloudflare
npx wrangler deploy
echo "$YOUR_TOKEN" | npx wrangler secret put GITHUB_WRITE_TOKEN
```

## Environment

Copy `.dev.vars.example` → `.dev.vars` for local dev. Production secrets
go through `wrangler secret put`.

## Architecture

Single Cloudflare Worker with Flue agents. See `docs/FLUE-MIGRATION-SPEC.md`.
