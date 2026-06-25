# Hermes Control Plane

Background coding agent control plane. A user posts a task; the system spins up
a sandboxed [OpenCode](https://opencode.ai) session, the agent makes the
changes, opens a real GitHub PR, then tears the sandbox down.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the gap analysis against a
production-grade background agent ([Ramp Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent))
and the prioritized improvement plan (including the locked P1.1 OAuth
design in §14). See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the
release plan + Hermes + Slack integration, and [`docs/SETUP.md`](docs/SETUP.md)
for local-development setup.

## Architecture

Three processes:

```
┌─────────────────┐       ┌────────────────────────┐       ┌──────────────────┐
│ Client          │       │ control-plane-launcher        │       │ Cloudflare       │
│ (web / Slack /  │ HTTPS │ (Bun, src/launcher)    │ HTTPS │ Worker + DO      │
│  CLI / curl)    │──────▶│  - holds E2B + GH App  │──────▶│  - session state │
│                 │       │    credentials         │       │  - event log     │
│                 │       │  - per-session reaper  │       │  - WS hub        │
│                 │       │  - orphan sweeper      │       │  - approval gate │
└─────────────────┘       └────────────────────────┘       └──────────────────┘
                                     │                              ▲
                                     │ E2B SDK                      │ WSS (runner dials back
                                     ▼                              │  through PUBLIC_BASE_URL
                          ┌────────────────────────┐                │  — ngrok in dev)
                          │ E2B sandbox            │                │
                          │  /opt/control-plane/          │                │
                          │   supervisor.js  ───┐  │                │
                          │   runner.js      ◀──┘  │────────────────┘
                          │  opencode CLI          │
                          │  /home/user/repo       │
                          └────────────────────────┘
```

Why the launcher exists: the Cloudflare Workers runtime cannot safely drive
the E2B SDK (silent `workerd` crashes during long `waitUntil` work). So we
split responsibilities: the Worker is the small stateful orchestrator; the
launcher is a single Bun process that owns sandbox lifecycle and the
credentials. Details in [`docs/ROADMAP.md §9.2`](docs/ROADMAP.md).

## Flow

1. Client `POST /sessions { repoUrl, taskDescription }` on the launcher.
2. Launcher checks the concurrency cap, then asks the Worker to create a
   `SessionDurableObject`. Worker returns `{ sessionId, runnerToken }`.
3. Launcher calls `Sandbox.create()` from a pre-baked E2B template
   (`hermes-runner`) — Node, bun, `opencode`, supervisor, runner all in the
   snapshot. Cold start ≈ 700–1500 ms.
4. Launcher mints a short-lived, repo-scoped GitHub App installation token,
   `git clone`s the repo inside the sandbox, then drops
   `/opt/control-plane/start.json` with per-session env (runner token, control WS URL,
   GH token, model).
5. The supervisor (already running in the snapshot, courtesy `setStartCmd`)
   sees the file appear and `exec`s the runner. The runner dials the Worker
   over WS using the public URL, registers itself, and is sent the first
   `agent.prompt`.
6. `opencode` does the work. Events stream to the Worker DO and through to
   subscribed clients. On completion the runner emits `git.diff.ready`.
7. Launcher sees `review_ready` on the Worker, triggers `/create-pr`. Runner
   creates the branch, pushes via the GH App token, opens the PR via REST,
   emits `pr.created`. DO transitions to `completed`.
8. Launcher's watcher sees `completed`, kills the sandbox. Concurrency slot
   freed.

If anything goes wrong (bad repo, bad template, runner stall, sidecar crash),
the launcher still ensures the sandbox is reaped — see
[`docs/ROADMAP.md §10.2`](docs/ROADMAP.md).

## Session states

```
created → provisioning → runner_connecting → ready → running
running → needs_approval → running
running → review_ready → creating_pr → completed     ← terminal (PR opened)
running → stalled → failed                            ← terminal
running → failed | aborted                            ← terminal
```

Transitions are enforced by `src/core/state-machine.ts`.

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
    github-token.ts           short-lived, repo-scoped GH App installation token
    sweeper.ts                orphan reaper (kills sandboxes tied to terminal/unknown sessions)
  runner/                     runs inside the sandbox
    supervisor.ts             baked into the template; waits for start.json, execs runner
    supervisor-helpers.ts     env-prep / readiness helpers used by supervisor
    sandbox-runner.ts         opencode SDK + SSE driver, WS bridge, PR creation
    bridge.ts                 WS bridge: DO ↔ runner framing + reconnect loop
    event-mapper.ts           OpenCode SSE → HermesEvent mapping (locked in §11.9)
  providers/
    mock.ts                   in-memory sandbox provider for unit tests
infra/e2b/
  build-template.ts           builds the `hermes-runner` E2B template
scripts/
  launch-session.ts           CLI: calls the sidecar by default, direct-mode fallback
tests/                        vitest suites (state machine, event log, sweeper, provision, etc.)
skills/                       Hermes-agent skill files (see docs/DEPLOYMENT.md §12)
  README.md                   loader contract + how to add a skill
  hermes-code-task/           run a coding task, open a PR (the primary skill)
  hermes-session-status/      `/hermes status <id>` lookup
  hermes-abort-task/          cancel + tear down a session
docs/
  SETUP.md                    local-dev setup
  ROADMAP.md                  gap analysis + verified results + locked P1.1 OAuth design (§14)
  DEPLOYMENT.md               deployment plan, release pipeline, Hermes + Slack integration
```

## Running it locally

You need: bun 1.3+, wrangler, ngrok (free is fine), and an E2B Hobby account.
Full step-by-step in [`docs/SETUP.md`](docs/SETUP.md). The short version:

```bash
bun install

# Build the E2B template once (or whenever runner/supervisor change)
E2B_API_KEY=… bun run template:build

# Three terminals:
bun run dev                                  # 1. Cloudflare Worker on :8787
ngrok http 8787                              # 2. public URL for the runner to dial
HERMES_CP_BASE_URL=https://<ngrok> \
E2B_API_KEY=… ZAI_API_KEY=… \
GITHUB_USER_TOKEN=$(gh auth token) GITHUB_USER_LOGIN=<your-handle> \
bun run launcher                             # 3. sidecar on :8789

# Trigger a session:
curl -X POST http://localhost:8789/sessions \
  -H 'Content-Type: application/json' \
  -d '{"taskDescription":"…","repoUrl":"https://github.com/you/repo"}'
```

## HTTP API

### Launcher (`http://localhost:8789` by default)

| Method | Path | Body / notes |
|--------|------|---|
| `GET` | `/health` | sidecar status + active sessions + cap |
| `POST` | `/sessions` | `{ taskDescription, repoUrl, projectId?, baseBranch? }`. Returns `{ sessionId, sandboxId, streamUrl, stateUrl }` |
| `GET` | `/sessions/:id` | passthrough to Worker state |
| `DELETE` | `/sessions/:id` | kill sandbox + abort DO session (works even if sidecar forgot the session) |

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

## Environment variables

The Worker (`.dev.vars` or `wrangler secret put`):

| Var | Purpose |
|-----|---------|
| `HEARTBEAT_TIMEOUT_MS` | runner stall threshold (default 15 min — see `src/core/constants.ts` for rationale) |
| `MAX_CONCURRENT_SESSIONS` | Hobby-tier headroom (default 10; E2B Hobby cap is 20) |
| `PUBLIC_BASE_URL` | optional; if unset, the Worker uses the request origin |

The launcher (process env):

| Var | Purpose |
|-----|---------|
| `E2B_API_KEY` | required |
| `E2B_TEMPLATE` | template alias, default `hermes-runner` |
| `HERMES_CP_BASE_URL` | required; URL of the deployed Worker (or ngrok in dev). Used both for launcher→Worker calls and as the WS dial-back URL given to the runner inside the sandbox. |
| `HERMES_CP_LAUNCHER_PORT` | default `8789` |
| `ZAI_API_KEY` | required; OpenCode (z.ai) provider key |
| `GITHUB_USER_TOKEN` | required; fine-grained PAT (Contents + Pull-requests RW). Runner uses it for `git push` + `POST /pulls` so the PR `author` is the real user. |
| `GITHUB_USER_LOGIN` | required; git author identity used inside the sandbox |
| `GITHUB_USER_EMAIL` | optional; defaults to `<login>@users.noreply.github.com` |

## Sandbox lifecycle

Owned by the launcher, not the Worker. The rules:

| Trigger | Action |
|---|---|
| Session reaches `completed` / `failed` / `aborted` | sandbox killed by the per-session watcher |
| Session reaches `review_ready` | launcher auto-triggers `/create-pr` |
| Launcher starts | orphan sweep: for each E2B sandbox tagged `metadata.hermes_session_id`, query Worker; kill if terminal or 404 |
| `DELETE /sessions/:id` | kill tracked sandbox, plus scan E2B for matching `hermes_session_id` metadata (covers post-restart cleanup) |
| Watcher hits 24-h deadline | force-kill (runaway-job backstop; paused sandboxes are free at E2B so the only reason to kill is a forgotten session — see ROADMAP §12.14) |
| Provision fails (bad repo, bad template, E2B down) | sandbox killed; DO aborted |

Every sandbox carries `metadata: { hermes_session_id, hermes_repo }` so the
sweeper can map strays back to sessions. Untagged sandboxes are never touched.

## Security model

- Runner gets a session-scoped WS token, never broad credentials.
- GitHub access uses two tokens per session: (a) a short-lived (≤ 1 h),
  single-repo GitHub App installation token, used as a fallback identity and
  for repo metadata; (b) the operator's `GITHUB_USER_TOKEN` (PAT or OAuth),
  used by the runner for `git push` + `POST /pulls` so the PR `author` is the
  real user. Single-user app: there is no per-user OAuth storage — the
  operator's token is supplied via launcher env. Multi-user OAuth storage is
  the locked design in [`docs/ROADMAP.md §14`](docs/ROADMAP.md).
- The sandbox is throwaway — any `rm -rf`, `git push --force`, or runaway loop
  dies with the sandbox.
- Task descriptions are treated as untrusted context, not as instructions to
  the launcher/Worker.
- Full event audit log is kept in Durable Object storage, replayable to any
  reconnecting client via `seq` cursor.
- All E2B and GitHub App credentials live in **one** process (the launcher).
  Clients (web, Slack, CLI) never see them.

## Tech stack

- **Control plane**: Cloudflare Workers + Durable Objects (DO Storage is the sole persistent store; D1/R2 were removed in §12.16 of ROADMAP)
- **Sandbox lifecycle**: Bun sidecar, E2B Sandboxes (Hobby tier)
- **Sandbox interior**: Node 22 + bun + OpenCode CLI + custom supervisor/runner
- **Agent runtime**: OpenCode driving Z.AI (`zai-coding-plan/glm-5.2` default)
- **Repo access**: GitHub App, short-lived installation tokens

## License

MIT
