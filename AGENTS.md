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
Hermes Agent → /mcp → CodeOps task adapter → coding-task Flue Workflow
                                              ↓
                                   private Flue agent profile
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
| `src/workflows/coding-task.ts` | Finite Flue coding Workflow and private agent profile |
| `src/app.ts` | Hono app with health, MCP, proxy routes, and flue() mount |
| `src/mcp/control-plan.ts` | Hermes-facing MCP tools, ambient Workflow invoke, and run reconciliation |
| `src/mcp/specialist-workflows.ts` | Ambient specialist Workflow invoke/poll adapter |
| `src/do/coding-task-do.ts` | Per-task durable domain correlation, publication lease, and lifecycle record |
| `src/do/admission-do.ts` | Global concurrent-task admission lease |
| `src/channels/github.ts` | Verified GitHub webhook ingress; dispatch is not wired yet |
| `src/cloudflare.ts` | Worker-level DO exports (Sandbox, task, approval, and PR index) |
| `src/do/pr-index-do.ts` | PR Index DurableObject |
| `src/agent/github-app.ts` | GitHub App installation authorization and short-lived repo-scoped tokens |
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
