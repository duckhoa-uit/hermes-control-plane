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
| Credential isolation | Sandbox exports a file-change manifest; Worker uses GitHub API for push/PR | `src/agents/hermes.ts`, `src/app.ts` |
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
5. Local tools run in the sandbox: bash, readFile, writeFile, git status/diff/commit
6. `git_push` exports a manifest of changed files and calls `/proxy/git-push`
7. Worker creates blobs/tree/commit/ref through GitHub's Git Database API
8. `create_pr` calls `/proxy/create-pr`
9. PR created on GitHub → lifecycle tracked in PrIndexDurableObject

## Secret boundary

The agent sandbox is treated as untrusted execution. It can inspect and mutate
the checked-out workspace, run tests, and produce a manifest of final file
contents, but it must not receive the long-lived GitHub write token.

Privileged GitHub writes happen in the Worker control plane:
- `/proxy/git-push` accepts a validated manifest and uses the Git Database API to
  create blobs, a tree, a commit, and the branch ref.
- `/proxy/create-pr` uses the GitHub Pull Requests API.

This keeps the current Flue/Worker architecture while avoiding token injection
into sandbox shell commands.
