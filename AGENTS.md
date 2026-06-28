# AGENTS.md — instructions for autonomous coding agents

## Stack

- **Runtime:** Cloudflare Worker (`src/`) + Durable Objects (SQLite).
  Deployed with `wrangler` via Flue build.
- **Agent framework:** [Flue](https://flueframework.com/) (`@flue/runtime`)
  — Pi harness runs inside DO, no external runner needed.
- **Sandbox:** Cloudflare Containers (`@cloudflare/sandbox`) — self-hosted
  via Dockerfile in `src/cf-sandbox/`. Replaces E2B.
- **Package manager:** Bun (1.3+). Lockfile is `bun.lock`.
- **Language:** TypeScript strict mode. `tsconfig.json` paths: `@/*` → `src/*`.
- **Tests:** Vitest (`tests/`). 140+ tests.

## Architecture

```
GitHub Webhook → /channels/github/webhook → HMAC verify → Agent dispatch
                                                              ↓
Agent runs in Durable Object (FlueHermesAgent) ← model calls (zai/glm-5.2)
                              ↓
              ┌─── Pi harness loop ───┐
              │ model → tools → model │  ← `defineAgent()` loop
              └───────────────────────┘
                              ↓
                   CF Sandbox container
                    (git clone, bash, read/write)
```

No VPS, no E2B, no OpenCode, no Bun launcher. Single CF Worker.

## Key files

| File | Purpose |
|---|---|
| `src/agents/hermes.ts` | Agent definition (defineAgent, tools, sandbox) |
| `src/app.ts` | Hono app with health + proxy routes + flue() mount |
| `src/channels/github.ts` | GitHub webhook (Flue channel pattern) |
| `src/cloudflare.ts` | Worker-level DO exports (Sandbox, PrIndexDurableObject) |
| `src/do/pr-index-do.ts` | PR Index DurableObject |
| `src/agent/pr-lifecycle.ts` | GitHub push/PR via Octokit |
| `src/agent/state-bridge.ts` | Flue lifecycle → Hermes state machine |
| `src/core/state-machine.ts` | Session state machine (11 states) |
| `src/cf-sandbox/Dockerfile` | Container image for agent sandbox |

## Commands

| Command | Purpose |
|---|---|
| `bun install` | Install deps |
| `bun run test` | Run all tests |
| `bun run typecheck` | TypeScript check |
| `bun run lint` | Oxlint |
| `npx flue build --target cloudflare` | Build for deploy |
| `npx wrangler deploy` | Deploy to Cloudflare |

## No legacy

This project uses Flue + Cloudflare Workers. No E2B, no OpenCode, no Bun
Launcher, no VPS. See `docs/FLUE-MIGRATION-SPEC.md` for migration details.
