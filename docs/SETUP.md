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
bun run test
bun run typecheck    # tsc --noEmit

# Local dev
npx flue build --target cloudflare
npx wrangler dev --port 8787

# Deploy (production)
# Follow docs/DEPLOYMENT.md for all secrets, runtime vars, dry-run, and smoke checks.
npx flue build --target cloudflare
npx wrangler deploy --dry-run
```

## Environment

Copy `.dev.vars.example` → `.dev.vars` for local dev. Production secrets and
deployment vars are documented in [`docs/DEPLOYMENT.md`](DEPLOYMENT.md).

## Architecture

Hermes Agent calls the Control Plan remote HTTP MCP server; Control Plan
dispatches to the Flue Durable Object and Cloudflare Sandbox `0.12.3`.
See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) and
[`docs/HERMES-AGENT-INTEGRATION.md`](HERMES-AGENT-INTEGRATION.md).
