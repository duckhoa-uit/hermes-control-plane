# Setup Guide

## Prerequisites

- bun 1.3+
- Node.js 22.18+ (for Flue CLI)
- Cloudflare account (Workers Paid for DO + Containers)
- wrangler CLI: `npm i -g wrangler`
- GitHub App with Metadata read, Contents read/write, and Pull requests read/write

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

For a Docker-backed Worker runtime smoke test, run `bun run test:worker`.
This builds the Flue bundle first and then exercises the built Worker through
Wrangler's `createTestHarness()`.

## Environment

Copy `.dev.vars.example` → `.dev.vars` for local dev. Production secrets and
deployment vars are documented in [`docs/DEPLOYMENT.md`](DEPLOYMENT.md).

## Architecture

Hermes Agent calls the authenticated remote HTTP MCP server; the Worker invokes
finite Flue Workflows in-process and their private profiles use Cloudflare
Sandbox `0.12.4`.
See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) and
[`docs/HERMES-AGENT-INTEGRATION.md`](HERMES-AGENT-INTEGRATION.md).
