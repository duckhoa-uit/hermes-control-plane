# Hermes Control Plane

Background coding agent control plane. A user posts a task; the system spins up
a sandboxed [OpenCode](https://opencode.ai) session, the agent makes the
changes, opens a real GitHub PR, then tears the sandbox down.

When the PR is opened, a per-PR webhook hook drives the rest of the
lifecycle automatically: reviewer "Request changes" or CI failures spawn
an *amend session* that pushes a follow-up commit onto the same PR
(no new PR opened). Merge → session archives. See
[`docs/DEPLOYMENT.md §13.3`](docs/DEPLOYMENT.md#133-github-webhook-pr-lifecycle)
for the full matrix.

Docs:
- [`AGENTS.md`](AGENTS.md) — agent-targeted instruction file (stack, commands, conventions, CI gates).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — full conventions playbook for humans.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the system works today (stable snapshot).
- [`docs/SETUP.md`](docs/SETUP.md) — local-development setup.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — release plan, Cloudflare Access, Hermes + Slack integration.
- [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) — on-call runbook: dashboards, alert channels, and the per-symptom triage steps. Alert rule declarations live in [`infra/observability/alerts.yaml`](infra/observability/alerts.yaml).
- [`docs/error-tracking.md`](docs/error-tracking.md) — PostHog error tracking + product analytics + the error→GitHub-issue webhook pipeline.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — gap analysis vs. [Ramp Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent), prioritized roadmap, implementation diaries, and the locked P1.1 OAuth design (§14).
- [`docs/api-reference.md`](docs/api-reference.md) and [`docs/events-reference.md`](docs/events-reference.md) and [`docs/state-machine.mmd`](docs/state-machine.mmd) — auto-generated from source by `bun run docs:gen`; refreshed on every push to main by `.github/workflows/docs-refresh.yml`.

## Architecture

```
client ──HTTP──▶ launcher ──HTTP──▶ Worker + Durable Object ◀──WSS── runner
                    │                                                   │
                    └─────── E2B sandbox (per session) ─────────────────┘
```

Three processes: Worker + DO (state machine, event log, WS hub),
launcher (E2B + GH PAT, sandbox lifecycle), runner (inside the
sandbox, drives OpenCode). Full diagram, per-process responsibilities,
DO best-practice playbook, state machine and security model are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Project layout

```
src/
  core/                       pure logic, no I/O
    types.ts                  shared TS interfaces
    state-machine.ts          allowed transitions
    event-log.ts              append-only, replayable
    id.ts                     ids and tokens
    constants.ts              heartbeat / timeout
  worker/                     Cloudflare Worker (the control plane)
    index.ts                  HTTP routes + WS upgrade
    session-do.ts             SessionDurableObject (state machine, event log, WS hub)
    env.d.ts                  CloudflareEnv bindings
  launcher/                   Bun sidecar (sandbox lifecycle)
    server.ts                 HTTP API: POST/GET/DELETE /sessions, /health
    provision.ts              Sandbox.create + clone + drop start.json
    sweeper.ts                orphan reaper (kills sandboxes tied to terminal/unknown sessions)
  runner/                     runs inside the sandbox
    supervisor.ts             baked into the template; waits for start.json, execs runner
    supervisor-helpers.ts     env-prep / readiness helpers used by supervisor
    sandbox-runner.ts         opencode SDK + SSE driver, WS bridge, PR creation
    bridge.ts                 WS bridge: DO ↔ runner framing + reconnect loop
    event-mapper.ts           OpenCode SSE → HermesEvent mapping (locked in §11.9)
  mcp/
    server.ts                 Streamable HTTP MCP server (start_coding_task / status / follow-up / abort)
  providers/
    mock.ts                   in-memory sandbox provider for unit tests
  testing/
    api-client.ts             tiny HTTP client used by scripts
    fake-runner.ts            fake runner used by `e2e:real`
infra/
  e2b/build-template.ts       builds the `control-plane-runner` E2B template
  launcher/                   install.sh + env.example + systemd unit for the launcher VPS
  mcp/                        MCP server install notes for Hermes operators
scripts/
  launch-session.ts           CLI: calls the sidecar by default, direct-mode fallback
  e2e-real.ts                 real-workerd E2E against a fake runner (needs `bunx wrangler dev` running)
  e2e-full.ts                 full-system E2E: real E2B + real opencode + real GitHub PR
  sandbox-debug.ts            SSH into a live E2B sandbox; dump supervisor/runner logs + state
tests/                        vitest suites (state machine, event log, sweeper, provision, in-process DO E2E)
skills/                       Hermes-agent skill files (see docs/DEPLOYMENT.md §12)
  hermes-control-plane/SKILL.md   single skill teaching Hermes when to call the MCP tools and how to render results
docs/
  ARCHITECTURE.md             stable snapshot of how the system works today
  SETUP.md                    local-dev setup
  DEPLOYMENT.md               deployment plan, release pipeline, Hermes + Slack integration
  ROADMAP.md                  gap analysis + research/decision log + locked P1.1 OAuth design (§14)
```

## Running it locally

One-command bootstrap from a fresh clone:

```bash
bun run setup
```

That runs `scripts/dev-setup.sh`: verifies tooling, `bun install`, runs lint
+ typecheck + the vitest suite, copies `.dev.vars.example` → `.dev.vars`
(if missing), and lists the env vars still left to fill in. Idempotent.

**Codespaces / Dev Containers**: the repo ships a
[`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) so
opening this repo in VS Code Dev Containers, Cursor, or GitHub
Codespaces drops you into a Node 22 + Bun + `gh` env with the editor
extensions our toolchain wants. `bun run setup` runs on attach. See
[`.devcontainer/README.md`](.devcontainer/README.md) for the walkthrough.

Then, in three terminals:

```bash
# A — Worker
set -a && source .dev.vars && set +a && bunx wrangler dev

# B — Launcher sidecar
set -a && source .dev.vars && set +a && bun run launcher

# C — Real end-to-end PR against a throwaway repo
bun run e2e:full --repo https://github.com/<you>/<throwaway>
```

You need `bun 1.3+`, an E2B Hobby account, a Z.AI key, and a fine-grained
GitHub PAT. Full per-service walk-through is in
[`docs/SETUP.md`](docs/SETUP.md).

## HTTP API

Machine-readable OpenAPI 3.1 spec: [`docs/openapi.yaml`](docs/openapi.yaml).
The tables below mirror the most common operations; the spec is the
authoritative contract (and is sanity-checked in CI by
`bun run openapi:check`).

### Launcher (`http://localhost:8789` by default)

| Method | Path | Body / notes |
|--------|------|---|
| `GET` | `/health` | sidecar status + active sessions + cap |
| `POST` | `/sessions` | `{ taskDescription, repoUrl?, projectId?, baseBranch?, parentSessionId? }`. When `parentSessionId` is set, repo + base + amend triple are resolved from the parent's state + the global PR index (no new PR is opened — the runner pushes onto the parent PR's branch). Returns `{ sessionId, sandboxId, streamUrl, stateUrl, parentSessionId?, prMode? }`. |
| `GET` | `/sessions/:id` | passthrough to Worker state |
| `DELETE` | `/sessions/:id` | kill sandbox + abort DO session (works even if sidecar forgot the session) |
| `POST` | `/sessions/:id/resume` | called by the DO to thaw a paused sandbox (`Sandbox.connect`) |
| `*` | `/mcp` | MCP entrypoint (Slack/agent integrations) |

### Worker (`http://localhost:8787` by default)

| Method | Path | Notes |
|--------|------|---|
| `GET` | `/health` | |
| `POST` | `/sessions` | Lower-level: creates the DO without provisioning. Clients should prefer the launcher. |
| `GET` | `/sessions/:id` | Session + full event log + artifacts. **404** for unknown ids. |
| `WS` | `/sessions/:id/stream` | live event stream for clients |
| `WS` | `/sessions/:id/runner?token=…` | the runner inside the sandbox dials this |
| `POST` | `/sessions/:id/approve` | resolve a pending approval |
| `POST` | `/sessions/:id/abort` | force-abort |
| `POST` | `/sessions/:id/prompt` | follow-up prompt (runner must still be connected) |
| `POST` | `/sessions/:id/create-pr` | triggered automatically by the launcher on `review_ready` |
| `POST` | `/webhooks/github` | HMAC-SHA-256 verified webhook. Consumes `pull_request` (lifecycle: merged→archive, closed→mark), `pull_request_review` (changes_requested→auto-amend session), `check_run` (failure/timed_out→auto-amend session). See [`docs/DEPLOYMENT.md` §13.3](docs/DEPLOYMENT.md). |
| `GET` | `/pr-index?key=<owner/repo#N>` | Look up the PR index row (used by the launcher to verify a parent PR is still open before amend re-provision). |

## Tech stack

- **Control plane**: Cloudflare Workers + Durable Objects (DO Storage is the sole persistent store; D1/R2 were removed in §12.16 of ROADMAP)
  - SessionDurableObject — one DO instance per agent session.
  - PrIndexDurableObject — singleton DO (`idFromName("global")`) mapping `owner/repo#N` -> session. Lets `POST /webhooks/github` and MCP `send_followup_prompt` find the parent session of an open PR. New event types: `pr.updated`, `pr.merged`, `pr.closed`, `pr.autofix.triggered`, `pr.autofix.skipped`.
  - Auto-amend (PR #25): the webhook handler also spawns amend sessions on `pull_request_review.submitted` (state=changes_requested) and `check_run.completed` (failure / timed_out). Strict single-flight per PR + cap of 3 (`AUTOFIX_CAP_PER_PR`).
- **Sandbox lifecycle**: Bun sidecar, E2B Sandboxes (Hobby tier)
- **Sandbox interior**: Node 22 + bun + `opencode serve` (HTTP/SSE) + custom supervisor/runner
- **Agent runtime**: OpenCode driving Z.AI (`zai-coding-plan/glm-5.2` default)
- **Repo access**: two single-user fine-grained GitHub PATs. `GITHUB_WRITE_TOKEN` (Contents + Pull-requests RW) lives **only** in the launcher process and is used by `POST /sessions/:id/publish-pr` to push + open PRs on the operator's behalf. `GITHUB_READ_TOKEN` (Contents Read) is baked into the sandbox's `.git/config` so clone + fetch work; the sandbox cannot push. Multi-user OAuth is the locked design in [`docs/ROADMAP.md §14`](docs/ROADMAP.md).

## License

MIT
