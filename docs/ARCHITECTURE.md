# Architecture

**Status:** Current (post-Flue migration, 2026-06-28).

## Overview

Single Cloudflare Worker using Flue agent framework. No VPS, no E2B, no OpenCode.

```
┌─ GitHub Webhook ─┐    ┌──────────────────────────────┐
│                  │───▶│ Worker (Hono + Flue)          │
│ PR opened/push   │    │  - FlueHermesAgent (DO)       │
│ webhook events   │    │  - SQLite persistence         │
└──────────────────┘    │  - Pi harness                 │
                        │  - GitHub proxy routes        │
                        │  - PR Index DO                │
                        └──────────┬───────────────────┘
                                   │
                          ┌────────▼────────┐
                          │ CF Sandbox      │
                          │ (Container)     │
                          │  - bash, git    │
                          │  - npm, Bun     │
                          └─────────────────┘
```

## Key components

| Component | What | Where |
|---|---|---|
| Flue agent | `defineAgent()` with Pi harness loop | `src/agents/hermes.ts` |
| Model provider | z.ai (glm-5.2) via `registerProvider('zai', ...)` | Agent initializer |
| Sandbox | Cloudflare Container, `cloudflareSandbox(getSandbox(...))` | Agent definition |
| GitHub webhook | HMAC-verified via `@flue/github` channel | `src/channels/github.ts` |
| Credential isolation | Tools call `/proxy/git-push` / `/proxy/create-pr` | `src/app.ts` |
| PR tracking | `PrIndexDurableObject` with SQLite | `src/do/pr-index-do.ts` |
| State machine | 11 states: created → provisioning → running → ... → archived | `src/core/state-machine.ts` |

## Runtime

One Cloudflare Worker + 5 Durable Object classes:
- `Sandbox` (Container) — from `@cloudflare/sandbox`
- `PrIndexDurableObject` — PR index
- `FlueRegistry` — Flue internal
- `FlueHermesAgent` — Flue-generated agent DO
- `FLUE_REGISTRY` — alias for FlueRegistry

## Agent lifecycle

1. GitHub webhook → `/channels/github/webhook` → HMAC verify
2. Agent dispatch (optional: via direct POST `/agents/hermes/:id`)
3. Pi harness loop: model call → tool execution → model call...
4. Sandbox container created for bash/git operations
5. Tools: bash, readFile, writeFile, git_push (proxy), create_pr (proxy)
6. PR created on GitHub → lifecycle tracked in PrIndexDurableObject
