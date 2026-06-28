# Hermes Control Plane

AI coding agent for automated PR reviews and fixes, powered by Flue + Cloudflare Workers.

## Architecture

- **Flue** (`@flue/runtime`) — agent framework with Pi harness loop
- **Cloudflare Workers** + Durable Objects — single runtime (no VPS)
- **Cloudflare Containers** — sandbox for git, bash, npm (replaces E2B)
- **z.ai (glm-5.2)** — LLM provider
- **GitHub webhooks** — triggers via `/channels/github/webhook`

## Quick start

```bash
bun install
bun run test
npx flue build --target cloudflare
npx wrangler deploy
```

See `docs/SETUP.md` for full instructions.
