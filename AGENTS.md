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
- **Tests:** Vitest (`tests/`).

## Architecture

```
Hermes Agent → /mcp → Control Plan task service → FlueControlPlanAgent DO
                                                  ↓
                                       Pi harness loop (model → tools → model)
                                                  ↓
                                       CF Sandbox container
                                       (git clone, bash, read/write)

GitHub Webhook → /channels/github/webhook → HMAC verify → log/ack (intentionally not a coding trigger)
```

Hermes Agent is the upstream orchestrator. Control Plan is the coding-agent
execution service: it exposes the remote MCP tools `spawn_coding_task`,
`get_coding_task`, `respond_coding_approval`, and `cancel_coding_task`.

No VPS, no E2B, no OpenCode, no Bun launcher. Single CF Worker.

## Key files

| File | Purpose |
|---|---|
| `src/agents/control-plan.ts` | Flue coding-agent definition (defineAgent, tools, sandbox) |
| `src/app.ts` | Hono app with health, MCP, proxy routes, and flue() mount |
| `src/mcp/control-plan.ts` | Hermes-facing MCP tools and Flue dispatch |
| `src/do/coding-task-do.ts` | Per-task durable correlation and lifecycle record |
| `src/do/admission-do.ts` | Global concurrent-task admission lease |
| `src/channels/github.ts` | Verified GitHub webhook ingress; dispatch is not wired yet |
| `src/cloudflare.ts` | Worker-level DO exports (Sandbox, task, approval, and PR index) |
| `src/do/pr-index-do.ts` | PR Index DurableObject |
| `src/agent/pr-lifecycle.ts` | GitHub push/PR via Octokit |
| `src/agent/state-bridge.ts` | Flue lifecycle → Control Plan state machine |
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
Launcher, no VPS. See `docs/ARCHITECTURE.md` for the current design and
`docs/DEPLOYMENT.md` for the current release procedure.
