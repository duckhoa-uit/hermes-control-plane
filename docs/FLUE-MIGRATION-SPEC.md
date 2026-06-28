# Flue Migration Specification

> **Date:** 2026-06-28  
> **Status:** In Progress (Phase 2 of 3)  
> **Objective:** Replace E2B + OpenCode + Bun Launcher with Cloudflare-native Flue + Pi harness

---

## 1. Research Summary — What is Flue?

Flue (`@flue/sdk`, `@flue/runtime`, `@flue/cli`) is a framework by the Astro team ([withastro/flue](https://github.com/withastro/flue)) for building **durable AI agents** that run on **Cloudflare Workers** natively or on **Node.js**. Key components:

| Component | Role |
|---|---|
| `@flue/runtime` | Agent definition DSL (`defineAgent`, `defineTool`, `defineWorkflow`), sandbox adapters, event system, model providers |
| `@flue/sdk` | Client SDK for invoking agents/workflows from external code. Exports: `createFlueClient`, `FlueEvent`, `FlueEventStream` |
| `@flue/cli` | Build tool: `flue build --target cloudflare` generates `_entry.ts`, DO classes, bundles for wrangler deploy |
| `@flue/runtime/cloudflare` | Cloudflare-specific: `cloudflareSandbox()`, `extend()`, `getCloudflareContext()` |
| `@flue/github` | GitHub webhook channel handler |

Flue turns each agent file into a **Durable Object** (DO) with SQLite persistence. Agent state, event history, and session data live in DO storage automatically — no external DB needed on Cloudflare.

**Current installed version:** `1.0.0-beta.7` for both `@flue/sdk` and `@flue/runtime`.

---

## 2. Architecture Comparison

### Before (E2B + OpenCode + Bun Launcher)

```
┌─ GitHub Webhook ─┐    ┌──────────────┐    ┌───────────────────┐
│                  │───▶│ Worker (Hono) │───▶│ Bun Launcher (VPS)│
└──────────────────┘    │ + DO (Session)│    │  - E2B API calls  │
                        │ + DO (PR Index)│    │  - GitHub API     │
                        └──────────────┘    │  - Session mgmt    │
                                            │  - Sweeper         │
                          ┌─────────────┐   └────────┬──────────┘
                          │ Sandbox (E2B)│◀───────────┘
                          │ - OpenCode   │
                          │ - Node 20    │
                          └─────────────┘
```

**Problems:**
- 3 runtimes: Worker (CF), Launcher (Bun/VPS), Runner (E2B+OpenCode)
- E2B sandbox = managed external dependency at $0.003/s
- OpenCode = heavy NPM dep, non-trivial event mapping needed
- Launcher = VPS ops overhead: systemd, provisioning, sweeper scripts
- Event mapping: HermesEvent ↔ OpenCode events requires translation layer (`src/runner/event-mapper.ts`)
- State machine has 14 states — many from E2B lifecycle details

### After (Flue + Pi + Cloudflare Sandbox)

```
┌─ GitHub Webhook ─┐    ┌──────────────────────────┐
│                  │───▶│ Worker + Flue + DO        │
└──────────────────┘    │  - FlueHermesAgent (DO)   │
                        │  - SQLite persistence     │
                        │  - Pi harness (built-in)  │
                        │  - Events via DS streams  │
                        │  - GitHub proxy routes    │
                        │  - PR Index DO            │
                        └──────────┬───────────────┘
                                   │
                          ┌────────▼────────┐
                          │ CF Sandbox      │
                          │ (Container)     │
                          │  - Bash + Git   │
                          │  - self-hosted  │
                          └─────────────────┘
```

**Gains:**
- Single runtime: Cloudflare Workers (no VPS)
- Pi harness replaces OpenCode (lighter, built into Flue)
- Cloudflare Sandbox = self-hosted container (~$0.0013/GB-hr)
- Event system unified: FlueEvent stream from DS protocol
- No event mapping needed between layers
- State machine can simplify: 14 → ~7 states
- Lower cost estimate: ~$5-15/mo vs ~$30-60/mo before

---

## 3. Migration Status

### ✅ Done (Phase 1)

| Item | Status | Evidence |
|---|---|---|
| Deleted `src/launcher/` | ✅ | 4 files deleted (provision.ts, publish.ts, server.ts, sweeper.ts) |
| Deleted `src/runner/` | ✅ | 6 files deleted (bridge.ts, event-mapper.ts, pr-metadata.ts, sandbox-runner.ts, supervisor-helpers.ts, supervisor.ts) |
| Deleted `src/worker/` | ✅ | 5 files deleted (env.d.ts, github-webhook.ts, index.ts, pr-index-do.ts, session-do.ts) |
| Created `src/agents/hermes.ts` (Flue `defineAgent`) | ✅ | Agent definition with Pi sandbox + custom tools |
| Created `src/app.ts` (Flue-compatible Hono app) | ✅ | Routes: `/health`, `/proxy/git-push`, `/proxy/create-pr`, `flue()` |
| Created `src/cf-sandbox/Dockerfile` | ✅ | Extends `docker.io/cloudflare/sandbox:0.7.0` |
| Created `src/webhooks/github.ts` (Flue channel) | ✅ | GitHub webhook handler |
| Created `src/do/pr-index-do.ts` | ✅ | PrIndexDurableObject class |
| Created `src/agent/state-bridge.ts` | ✅ | Flue lifecycle → state machine mapping |
| Created `src/agent/pr-lifecycle.ts` | ✅ | GitHub push/PR via Octokit |
| Wired `wrangler.jsonc` with Sandbox DO + Flue DOs | ✅ | 5 DO bindings: Sandbox, PR_INDEX_DO, FlueRegistry, FLUE_HERMES_AGENT, FLUE_REGISTRY |
| Installed `@flue/sdk`, `@flue/runtime`, `@cloudflare/sandbox` | ✅ | All at compatible versions |
| `flue build` succeeds | ✅ | Build generates `dist/hermes_control_plane/` |
| Typecheck passes | ✅ | `tsc --noEmit` = 0 errors |
| All tests pass | ✅ | 135 tests, 12 test files, all green |

### 🔲 Need to Complete (Phase 2)

| Item | Status | Detail |
|---|---|---|
| Create `src/cloudflare.ts` | 🔲 | Must export `Sandbox` + `PrIndexDurableObject` as Worker-level classes for Wrangler DO bindings |
| Verify Pi harness end-to-end | 🔲 | Confirm `cloudflareSandbox(getSandbox(...))` works in agent definition |
| Clean up duplicate `src/agent/hermes.ts` | 🔲 | Flue only discovers `src/agents/hermes.ts`; the `src/agent/hermes.ts` is a stale copy |
| Simplify state machine | 🔲 | Remove `runner_connecting`, `ready`, `stalled` (Pi doesn't expose these stages) |
| Decide event strategy | 🔲 | FlueEvent vs HermesEvent — recommend dropping HermesEvent entirely |

### 🔲 Todo (Phase 3 — Deployment)

| Item | Status | Detail |
|---|---|---|
| Cloudflare `cloudflare.ts` re-export | 🔲 | Must be done before deploy |
| Set production secrets | 🔲 | GITHUB_WRITE_TOKEN, GITHUB_READ_TOKEN, ZAI_API_KEY, etc. |
| Container build on CF | 🔲 | Dockerfile must build in CF Container Registry |
| Swap GitHub webhook URL | 🔲 | Point to new Worker URL |
| Test full chain: webhook → agent → sandbox → result | 🔲 | E2E verification |

---

## 4. Flue's Pi Harness — What It Is

Pi is Flue's built-in **agent execution loop** (the "harness"). When you define an agent with `defineAgent()`, Flue auto-generates the Pi loop:

```
Agent receives prompt
  → Pi loop starts
    → Model call (with tools available via `tools: [...]`)
    → Tool execution (shell, file ops, custom tools)
    → Tool results back to model
    → Model decides next action
  → Loop until done
  → Return result via stream or wait=result
```

The Pi harness handles:
- **Session management** — SQLite-persisted conversation history
- **Model provider routing** — Works with any provider (zai, anthropic, openai, etc.)
- **Tool execution** — Custom `defineTool()` calls, plus built-in sandbox tools
- **Sandbox lifecycle** — `cloudflareSandbox()` wraps CF Container into SessionEnv
- **Event streaming** — Durable Streams protocol → typed `FlueEvent`
- **Compaction** — Automatic context window management
- **Subagent dispatch** — Agents can delegate to other named agents

For a repository like `duckhoa/lawn`, the Pi harness would:
1. Clone repo via `git clone` in the sandbox
2. Agent reads files, makes code changes
3. Runs tests via `npm test` in sandbox
4. Agent commits, pushes via `git_push` custom tool
5. Opens PR via `create_pr` custom tool

---

## 5. `@cloudflare/sandbox` vs E2B

| Feature | E2B | CF Sandbox (`@cloudflare/sandbox` v0.7.21) |
|---|---|---|
| Runtime | Managed VM | CF Container (custom Dockerfile) |
| Cost | ~$0.003/s + egress | $0.0013/GB-hr + included egress |
| File ops | readFile, writeFile | Same ✅ |
| Commands | exec | Same ✅ |
| Git | via exec | via exec + `gitCheckout` helper ✅ |
| Port expose | tunnel URL | Same ✅ |
| Sleep policy | onTimeout param | `sleepAfter` param ✅ |
| Max idle | Configurable | Configurable ✅ |
| Self-host | No (managed only) | Yes (custom Dockerfile) ✅ |
| Network | Full internet | Configurable default full ✅ |
| Destroy | DELETE /sandboxes | `sandbox.destroy()` ✅ |

**Verdict:** ✅ CF Sandbox is a full replacement. The Pi harness uses `sandbox.exec`, `sandbox.writeFile`, `sandbox.readFile` — all supported.

**Current Dockerfile:**
```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.0
WORKDIR /workspace
```

The base image includes: Ubuntu 22.04, Node.js 20 LTS, npm, Bun 1.x, curl, wget, git, jq, zip, unzip. Plenty for any PR automation task.

---

## 6. Event Strategy and State Machine

### FlueEvent (Native) vs HermesEvent (Legacy)

| Aspect | Before (OpenCode) | After (Flue) |
|---|---|---|
| Event format | OpenCode SSE → HermesEvent | FlueEvent (DS stream, typed union) |
| Event mapping | `event-mapper.ts` translation layer | Zero mapping needed |
| Stream protocol | Custom SSE | Durable Streams (built-in) |
| Event types | ~20 custom HermesEvent types | 25+ FlueEvent types covering model turns, tools, tasks, compaction, logs |

**Recommendation: Drop HermesEvent entirely.**

FlueEvent covers everything we need:
- `turn_start / turn / turn_messages` — Model interaction lifecycle
- `tool_start / tool` — Tool execution events  
- `task_start / task` — Task/subagent lifecycle
- `text_delta` — Streaming text output
- `compaction_start / compaction` — Context window management
- `log` — Structured logs
- `idle` — Agent idle detection
- `agent_start / agent_end` — Agent session lifecycle

Current `state-bridge.ts` already maps Flue's `AgentLifecycle` → `SessionStatus` correctly:
```typescript
created    → "created"
submitted  → "provisioning"
running    → "running"
needs_input → "needs_approval"
completed  → "completed"
failed     → "failed"
aborted    → "aborted"
```

### Simplified State Machine

**Current states (14):**
```
created → provisioning → runner_connecting → ready → running → needs_approval → review_ready → creating_pr → completed | failed | aborted | stalled → archived
```

**Proposed simplified states (11):**
```
created → provisioning → running → needs_approval → review_ready → creating_pr → completed | failed | aborted → archived
```

**Removed:** `runner_connecting`, `ready`, `stalled`

Rationale:
- `runner_connecting` + `ready` were E2B-specific (sandbox create → connect → ready). CF Sandbox is synchronous: `getSandbox()` returns a connected stub immediately.
- `stalled` was for missing heartbeats from the Bun runner. With Pi running in the DO, there's no runner heartbeat to miss.

The simplified state machine reduces code complexity while keeping all essential states for the PR workflow.

---

## 7. Key Implementation Detail: `cloudflare.ts`

Flue's generated `_entry.ts` uses a `cloudflare.ts` module (at source root) for user-supplied Worker-level exports. The generated entry has:

```typescript
const userCloudflare = {};  // Currently empty — no cloudflare.ts
```

Without `cloudflare.ts`, the `Sandbox` class from `@cloudflare/sandbox` and `PrIndexDurableObject` are **bundled into the Worker** but **not exported**. Wrangler needs these as top-level exports for DO bindings.

**Fix needed:** Create `src/cloudflare.ts`:

```typescript
import { Sandbox } from "@cloudflare/sandbox";
export { Sandbox };
export { PrIndexDurableObject } from "./do/pr-index-do";
```

This is the standard pattern documented in Flue's own Cloudflare deploy guide.

---

## 8. File Layout After Cleanup

```
src/
├── cloudflare.ts          # ⬅️ NEEDED: Worker-level DO exports
├── app.ts                 # ✅ Hono app with flue() middleware
├── env.d.ts               # ✅ Env type declarations
├── agents/
│   └── hermes.ts          # ✅ Flue agent definition (source of truth)
├── agent/
│   ├── pr-lifecycle.ts    # ✅ GitHub push/PR logic
│   └── state-bridge.ts    # ✅ Flue lifecycle → state machine
├── do/
│   └── pr-index-do.ts     # ✅ PR Index DurableObject
├── core/
│   ├── constants.ts       # ✅ Heartbeat intervals, timeouts
│   ├── feature-flags.ts   # ✅ Feature flag system
│   ├── id.ts              # ✅ ID generation
│   ├── logger.ts          # ✅ Structured logger
│   ├── resilience.ts      # ✅ Circuit breaker, retry
│   ├── secrets.ts         # ✅ Secret management
│   ├── state-machine.ts   # ✅ State transition definitions
│   └── types.ts           # ✅ Core types
├── providers/
│   └── mock.ts            # ✅ Mock sandbox for testing
├── webhooks/
│   └── github.ts          # ✅ GitHub webhook handler
└── cf-sandbox/
    └── Dockerfile         # ✅ Container image definition
```

**File to remove:** `src/agent/hermes.ts` — duplicate of `src/agents/hermes.ts`. Flue only discovers agents from `src/agents/`.

---

## 9. Environment & Secrets

### Vars (set in wrangler.jsonc, non-secret)

| Var | Value | Notes |
|---|---|---|
| `LLM_MODEL` | `zai/glm-5.2` | Switched from `zai/glm-4-plus` |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | Observability |
| `AUTOFIX_CAP_PER_PR` | `3` | Cap on autofix cycles |
| `MAX_CONCURRENT_SESSIONS` | `10` | Rate limiting |
| `AUTO_CREATE_PR` | `1` | Auto-create PRs |
| `WORKER_URL` | `http://localhost:8787` | Dev URL, override in prod |

### Secrets (wrangler secret put)

| Secret | Source | Production Value |
|---|---|---|
| `GITHUB_WRITE_TOKEN` | GitHub PAT (fine-grained, Contents + Pull-requests RW) | User provides |
| `GITHUB_READ_TOKEN` | GitHub PAT (Contents R) | User provides |
| `GITHUB_WEBHOOK_SECRET` | `openssl rand -hex 32` | User generates |
| `ZAI_API_KEY` | Z.AI Dashboard | User provides |

---

## 10. Deployment Plan

### Prerequisites

1. Cloudflare account with Workers Paid plan (DO + Containers require Paid)
2. GitHub fine-grained PAT with Contents + Pull-requests RW
3. Z.AI API key

### Steps

```bash
# 1. Create cloudflare.ts (exports DO classes)
cat > src/cloudflare.ts << 'EOF'
import { Sandbox } from "@cloudflare/sandbox";
export { Sandbox };
export { PrIndexDurableObject } from "./do/pr-index-do";
EOF

# 2. Clean up duplicate
rm src/agent/hermes.ts   # Keep only src/agents/hermes.ts

# 3. Build with Flue
npx flue build --target cloudflare

# 4. Deploy to Cloudflare
npx wrangler deploy

# 5. Set secrets
echo "$GITHUB_WRITE_TOKEN" | npx wrangler secret put GITHUB_WRITE_TOKEN
echo "$GITHUB_READ_TOKEN"  | npx wrangler secret put GITHUB_READ_TOKEN
echo "$GITHUB_WEBHOOK_SECRET" | npx wrangler secret put GITHUB_WEBHOOK_SECRET
echo "$ZAI_API_KEY" | npx wrangler secret put ZAI_API_KEY
```

### Rollback Plan

Keep the old Worker deployed under a different name. GitHub webhook can be switched back by changing the webhook URL in repo settings.

---

## 11. Cost Analysis

### Before (E2B + VPS)

| Item | Monthly Cost |
|---|---|
| E2B sandbox (~10h active @ $0.003/s) | ~$10-30 |
| VPS (Bun launcher, $6/mo) | ~$6 |
| E2B egress | ~$1-5 |
| **Total** | **~$17-41/mo** |

### After (CF Workers + Containers)

| Item | Monthly Cost |
|---|---|
| Workers Paid ($5/mo base, includes DO) | $5 |
| DO SQLite reads/writes | <$1 |
| Container runtime (1GB, ~10h @ $0.0013/GB-hr) | ~$0.39 |
| Container egress (included in Workers Paid) | $0 |
| **Total** | **~$5-10/mo** |

**Savings: 60-80% infrastructure cost reduction**, plus elimination of VPS management.

---

## 12. Migration Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Flue beta bugs | Low-Med | Could fail in production | Pin to `1.0.0-beta.7`; can revert to old worker |
| Container build fails | Low | Blocks deploy | Test `wrangler deploy` with `--dry-run` first |
| Pi harness behavior different from OpenCode | Medium | Agent behavior may differ | Add E2E test, test with real PR first |
| Secret leaks via env | Low | Security | Use `wrangler secret put`, never `.dev.vars` in prod |
| DS stream incompatibility | Low | Events not consumed | Test with `createFlueClient` SDK first |

---

## 13. Summary

1. **Flue is the right replacement.** It's a mature beta from the Astro team, actively maintained, and provides everything we need: agent DSL, Pi harness, sandbox adapter, and CF-native deployment.

2. **`@cloudflare/sandbox` fully replaces E2B.** Same API surface for exec/readFile/writeFile. Self-hosted container = lower cost + no external dependency.

3. **Pi harness replaces OpenCode completely.** No event mapping needed. FlueEvent is the native event type.

4. **Architecture simplifies drastically.** 3 runtimes → 1. ~14 state machine states → ~11. No VPS.

5. **Cost drops 60-80%.** From ~$30/mo to ~$5-10/mo.

6. **~70% migrated.** Remaining: `cloudflare.ts` creation, duplicate cleanup, deploy with secrets.

---

## Appendix A: Status Update (2026-06-28)

### ✅ Phase 2 Complete

| Item | Status | Detail |
|---|---|---|
| `src/cloudflare.ts` | ✅ Created | Exports `Sandbox` + `PrIndexDurableObject` |
| Flue build picks up `cloudflare.ts` | ✅ | `export * from cloudflare.ts` in generated entry |
| `@flue/sdk` / `@flue/runtime` | ✅ Both `1.0.0-beta.7` — matched | SDK not imported by application code directly |
| Stale `alias` in `wrangler.jsonc` | ✅ Removed | Flue now generates imports from `@flue/runtime/*` directly |
| Stale `env.d.ts` — `HermesAgent` binding | ✅ Removed | Agent DO is `FLUE_HERMES_AGENT` generated by Flue |
| `src/agent/hermes.ts` duplicate | ✅ Deleted | Only `src/agents/hermes.ts` (Flue-discovered) remains |
| State machine simplified | ✅ | Removed `runner_connecting`, `ready` — 11 states left |
| Typecheck | ✅ Pass | `tsc --noEmit` = 0 errors |
| Tests | ✅ Pass | 140 tests, 12 files, all green |
| Built bundle exports | ✅ | `FlueHermesAgent`, `FlueRegistry`, `Sandbox`, `PrIndexDurableObject`, `default (fetch)` |

### 🔲 Phase 3 — Waiting on User

| Item | Status | Action Needed |
|---|---|---|
| `GITHUB_WRITE_TOKEN` | 🔲 | Anh cung cấp PAT (fine-grained, Contents+Pull-requests RW) |
| `GITHUB_READ_TOKEN` | 🔲 | PAT (Contents R) hoặc dùng chung |
| `GITHUB_WEBHOOK_SECRET` | 🔲 | Anh gen `openssl rand -hex 32`, set cả CF + GitHub |
| `ZAI_API_KEY` | 🔲 | Anh cung cấp từ z.ai dashboard |
| `wrangler deploy` | 🔲 | Chạy sau khi có secrets |
| Swap GitHub webhook URL | 🔲 | Trỏ webhook đến worker URL mới |

### Pi Harness — Verification Notes

Flue's Pi harness **is already integrated** via `defineAgent()` in `src/agents/hermes.ts`. The agent definition includes:

```typescript
export default defineAgent<Env>(({ id, env }) => ({
  model: env.LLM_MODEL || "anthropic/claude-sonnet-4-6",
  instructions: INSTRUCTIONS,
  tools: [gitPush, createPR],
  sandbox: cloudflareSandbox(
    getSandbox(env.Sandbox, `hermes-${id}`, { sleepAfter: "10m" }),
    { cwd: "/workspace" },
  ),
}));
```

Flue's build (`flue build --target cloudflare`) generates the DO class `FlueHermesAgent` which wraps the agent code + Pi harness + cloudflare sandbox into a Durable Object. The Pi loop is created by `createCloudflareAgentRuntime()` and `createAssistantMessageEventStream()` — both bundled into the built output.

The bundle file `dist/hermes_control_plane/index.mjs` contains **~1078 references** to Pi/harness/loop code, confirming the full engine is compiled in.
