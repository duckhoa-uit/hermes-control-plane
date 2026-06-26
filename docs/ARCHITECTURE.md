# Architecture

Snapshot of how the system works *today*. Stable; updated only on
behavioural changes (refactors that change file layout do **not**
need to update this doc).

- For the diary of how we got here → [`ROADMAP.md`](./ROADMAP.md).
- For local dev → [`SETUP.md`](./SETUP.md).
- For production → [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## 1. Components

```
┌──────────┐  HTTPS   ┌──────────────┐  HTTPS  ┌──────────────────┐
│  Client  │ ───────▶ │   Launcher   │ ──────▶ │ Cloudflare       │
│ (curl /  │          │  (Bun, VPS)  │         │ Worker + DO      │
│  Slack)  │          │              │         │ (the control     │
└──────────┘          └──────┬───────┘         │  plane proper)   │
                             │ E2B SDK         └────────┬─────────┘
                             ▼                          ▲
                      ┌──────────────┐                  │ WSS
                      │ E2B sandbox  │ ─── runner ──────┘
                      │ (per session)│   dials back
                      └──────────────┘
```

Three processes, three responsibilities:

| Process | Role | Why it's separate |
|---|---|---|
| **Worker + Durable Object** (`src/worker/`) | State machine, event log, WebSocket hub, approval gate. One DO instance per session. | Cheap, hibernatable, single-writer per session. |
| **PR Index Durable Object** (`src/worker/pr-index-do.ts`) | Singleton DO mapping `owner/repo#N` -> { sessionId, ownerLogin, status, autofixCount }. Consumed by the GitHub webhook handler and by MCP `send_followup_prompt`. | One row per Hermes-opened PR is far cheaper than scanning all `SessionDurableObject` instances for a match. |
| **Launcher** (`src/launcher/`) | Owns the E2B SDK + GitHub PAT. Creates/destroys sandboxes, sweeps orphans, calls the Worker for state. | The Workers runtime crashes silently when driving the E2B SDK through long `waitUntil` work (`workerd` aborts during the SDK's long-poll loop — see [`ROADMAP.md §9.2`](./ROADMAP.md)). The launcher absorbs all long-lived I/O. |
| **Runner** (`src/runner/`) | Runs *inside* the sandbox. Drives `opencode serve` over HTTP/SSE, streams events, opens the PR. Bundled into a pre-baked E2B template (`control-plane-runner`). | Has to be next to the repo + the OpenCode server (it speaks the OpenCode HTTP/SSE API on `localhost:4096`). |

## 2. Request flow (happy path)

1. **Client** `POST /sessions` on the launcher with
   `{ repoUrl, taskDescription }`.
2. **Launcher** checks the E2B concurrency cap
   (`MAX_CONCURRENT_SESSIONS`, default 10), then calls the Worker's
   `POST /sessions`. The Worker creates a `SessionDurableObject`,
   returns `{ sessionId, runnerToken }`.
3. **Launcher** `Sandbox.create()` from the `control-plane-runner`
   template, with `lifecycle: { onTimeout: "pause", autoResume: true }`
   and a 15 min idle timeout.
4. **Launcher** `git clone`s the repo inside the sandbox using a
   *read-only* PAT (`GITHUB_READ_TOKEN`), bakes that token
   into `.git/config` so subsequent `git fetch` works, then drops
   `/opt/control-plane/start.json` with the per-session env (runner
   token, Worker WS URL, model, owner/repo, base branch — but **no**
   write-scoped PAT).  The write token (`GITHUB_WRITE_TOKEN`)
   never enters the sandbox; it lives only in the launcher process.
5. **Supervisor** (already running in the snapshot via `setStartCmd`)
   sees the file appear and `exec`s the runner.
6. **Runner** dials the Worker's `/sessions/:id/runner?token=…` over
   WS, registers, and receives the first `agent.prompt` command.
7. **Runner** drives OpenCode, streams `agent.message.delta` /
   `tool.call` / `tool.result` events back through the DO; the DO
   broadcasts them to all subscribed clients on `/sessions/:id/stream`.
8. On `review_ready`, the launcher auto-fires the DO's `/create-pr`
   (configurable via `CONTROL_PLANE_AUTO_PR`).  The runner does local
   prep only — `git add` / `git commit` / `git rev-parse HEAD` plus
   an agent-authored title+body — and emits
   `runner.ready_to_publish` over WS.  The DO calls the launcher's
   `POST /sessions/:id/publish-pr`; the launcher pushes via a
   *one-shot* `hermes-publish` remote (write token passed in env,
   never persisted to `.git/config`), opens the PR via the REST
   `POST /repos/:owner/:repo/pulls`, removes the temp remote, and
   returns `{ prUrl, prNumber }`.  The DO synthesises `pr.created`
   (or `pr.updated` in amend mode) and transitions to `completed`.
9. The per-session watcher kills the sandbox once the DO reaches a
   terminal state.

## 3. Durable Object — Cloudflare best-practice playbook

`SessionDurableObject` (`src/worker/session-do.ts`) follows the
Cloudflare Workers best-practice guide end-to-end. The refactor diary
is at [`ROADMAP.md §12.18`](./ROADMAP.md#1218-cloudflare-best-practices-refactor-of-sessiondurableobject-2026-06-25).

- **Typed RPC, not `stub.fetch()`.** Worker → DO calls go through
  typed methods: `initSession`, `getState`, `sendPrompt`,
  `approveRequest`, `abortSession`, `createPR`. The only
  `stub.fetch()` left is the WebSocket upgrade hop because RPC can't
  return a `WebSocket`. The binding is typed as
  `DurableObjectNamespace<SessionDurableObject>` so the call sites
  get TypeScript inference end-to-end. A single `asRpc()` cast in
  `src/worker/index.ts` works around `Rpc.Provider<T>` rejecting
  `Record<string, unknown>` payloads (which `HermesEvent.payload`
  pervasively uses) — switching to `any` triggers TS2589.
- **WebSocket Hibernation API.** Both client (`tag: "client"`) and
  runner (`tag: "runner"`) sockets go through
  `ctx.acceptWebSocket(ws, [tag])`. Per-WS state lives in
  `ws.serializeAttachment({ tag, lastSeq })`. Message/close/error
  handling is the `override webSocketMessage/Close/Error` trio.
  Lookups are `ctx.getWebSockets(tag)` — no in-memory `Set<WS>`,
  no `runnerConn` field. Sockets survive DO hibernation; the DO
  pays zero CPU between events.
- **Alarm-driven heartbeat.** No `setInterval`. The heartbeat
  watchdog is scheduled via `ctx.storage.setAlarm()` and re-armed
  inside `override async alarm()`. The DO hibernates between alarm
  ticks.
- **Persisted event log.** Each event is written under its own key
  `evt:<10-digit-seq>` via `storage.put`. On wakeup, the log is
  rehydrated with `storage.list({ prefix: "evt:" })`.
  `EventLog.appendExisting()` is the restore path. No single big-blob
  `events` key to corrupt.
- **`blockConcurrencyWhile` init.** The first request can't race
  storage hydration: `init()` runs inside `ctx.blockConcurrencyWhile()`.
- **`wrangler.jsonc` + observability.** Config is JSONC with
  `$schema`. `[observability]` is on with 10 % head sampling.

### Hibernation invariants

- Each WS carries `{ tag: "client" | "runner", lastSeq: number }` in
  its attachment.
- `getRunnerWS()` returns `ctx.getWebSockets("runner")[0] ?? null` —
  the design assumes ≤ 1 runner per session.
- DO has **one** alarm slot; today it's used for the heartbeat
  watchdog. Future scheduled work needs a queue-of-times pattern.

## 3.b PR lifecycle & amend mode

When the runner emits `pr.created`, the SessionDurableObject calls
`PR_INDEX_DO.register(prKey, sessionId, ownerLogin)` (fire-and-forget
via `ctx.waitUntil`). The index row keeps the PR addressable globally
for the lifetime of the open PR.

Two consumers of the index:

1. **`POST /webhooks/github`** — verified by HMAC-SHA-256 against
   `GITHUB_WEBHOOK_SECRET`. Scope is narrow on purpose: we subscribe
   to `pull_request` events only. The handler:
   1. looks up the PR in the index;
   2. dedupes by `X-GitHub-Delivery` (bounded 16-entry ring per PR);
   3. flips the row's `status` (`open` -> `merged` | `closed`);
   4. dispatches `SESSION_DO.ingestPrLifecycleEvent` to append
      `pr.merged` / `pr.closed` to the session's event log and (on
      merge) transition `completed -> archived`;
   5. unregisters the row on merge (closed-unmerged keeps the row
      in case the PR is reopened).

   Reviewer "Request changes" and CI failures are webhook-driven —
   see the auto-amend section below. Manual follow-up goes through
   MCP (`send_followup_prompt`).

2. **MCP `send_followup_prompt`** — when called against a terminal
   session whose PR is still open, the launcher transparently spawns
   a fresh session in **amend mode** against the same PR
   (`parentSessionId`). The new sandbox checks out the existing PR
   branch instead of creating `hermes/<short>`, and the publish phase
   tells the launcher to **skip `POST /pulls`** (PR already exists);
   the launcher pushes only and the DO emits `pr.updated`
   (idempotent on `artifacts.prUrl`). The result: the same PR number
   gets a follow-up commit, no second PR is opened.

```
                  pr.created
SessionDurableObject ──────────► PR_INDEX_DO ◄─────── POST /webhooks/github
                                  │  ▲                (lookup, markStatus,
                                  │  │                 recordDelivery,
                                  │  │                 tryClaimAmendSlot,
                                  │  │                 transferAmendSlot,
                                  │  │                 releaseAmendSlot)
                                  │  │
                MCP send_followup_prompt (terminal + PR open)
                                  │
                                  ▼
                  POST /sessions { parentSessionId }
                                  │
                                  ▼
                  provisionSession({ prMode })
                  └─ sandbox: git fetch origin <branch>;
                              git checkout -B <branch> origin/<branch>
                  └─ runner: skip POST /pulls; emit pr.updated
```

### Auto-amend on reviewer feedback + CI failure

The webhook handler also subscribes to two additional GitHub events and
spawns a fresh amend session when they fire on a PR Hermes opened:

```
GitHub  ┌── pull_request_review.submitted (state=changes_requested) ──┐
        │                                                              │
        └── check_run.completed (conclusion ∈ {failure, timed_out}) ───┤
                                                                       ▼
                                                    POST /webhooks/github
                                                                       │
                                            HMAC verify, dedup delivery
                                                                       │
                                          PR_INDEX_DO.lookup(prKey) ──┐│
                                                                     ││
                       PR_INDEX_DO.tryClaimAmendSlot(prKey,           ││
                              headSha, parentSessionId, cap=3)        ││
                                  ok? │   │ fail (cap_exceeded /      ││
                                      │   │       duplicate_sha /     ││
                                      │   │       inflight /          ││
                                      │   │       self_review)        ││
                                      ▼   │                           ││
       POST /sessions on launcher with    │                           ││
       { parentSessionId, taskDescription │                           ││
         built from review body / CI logs}│                           ││
                  │                       │                           ││
                  ▼                       ▼                           ▼▼
       newSessionId returned         pr.autofix.skipped         pr.autofix.skipped
       PR_INDEX_DO.transferAmendSlot                            (kind=ignored,
       pr.autofix.triggered                                      reason: stable)
                  │
                  ▼
       spawned session amends the PR
       on terminal → releaseAmendSlot
```

Constraints (locked PR #25):
- Cap of 3 amend sessions per PR (env `HERMES_AUTOFIX_CAP`).
- Strict single-flight per PR with a 10-minute TTL safety release for
  crashed amends.
- Self-trigger guard: `reviewerLogin === ownerLogin` is refused.
- Status of an auto-amend lives in the parent session's event log
  (`pr.autofix.triggered` / `pr.autofix.skipped`); no bot reply comment
  is posted on the PR.

## 4. Session state machine

`src/core/state-machine.ts` enforces the allowed transitions; valid
states are in `src/core/types.ts`:

```
created → provisioning → runner_connecting → ready → running
                                                        │
                       ┌────────────────────────────────┼────────────┐
                       ▼                                ▼            ▼
                  needs_approval                  review_ready    stalled
                       │                                │            │
                       └──────────► running ◄───────────┘            │
                                       │                             │
                                       ├──► creating_pr ──► completed (terminal)
                                       ├──► aborted     (terminal)
                                       └──► failed      (terminal)
```

`stalled` is a soft-terminal: the watchdog flips here once
`HEARTBEAT_TIMEOUT_MS` (15 min, `src/core/constants.ts`) elapses with
no runner heartbeat *while in `running`*. From `stalled` the system
either recovers (`running`) or escalates to `failed`. `review_ready`
intentionally has the heartbeat watchdog disabled — E2B pauses the
sandbox at 15 min idle and stale heartbeats there are not a failure
(see [`ROADMAP.md §12.7`](./ROADMAP.md)).

## 5. Event log

Append-only, replayable. Two consumers:

- **Live clients** subscribed on `/sessions/:id/stream` get every
  event from `lastSeq + 1` on (re)connect, then live events as they
  fire.
- **`GET /sessions/:id`** returns the full log + the current state +
  the artifacts dictionary (`summary`, `diff`, `prUrl`, …).

Events are produced by the DO state machine, the runner (via the WS
bridge), and the launcher (via the resume path). The full event
taxonomy lives in `src/core/types.ts:HermesEvent`.

## 6. Runner internals

`src/runner/`:

- `supervisor.ts` (baked into the template). Polls
  `/opt/control-plane/start.json`, starts the OpenCode HTTP server
  (`opencode serve` on `127.0.0.1:4096`), waits for it via a **TCP
  probe** (not log scraping — snapshot/restore makes `Date.now()`
  jump past pre-snapshot deadlines and log-based readiness then
  misfires; see [`ROADMAP.md §12.18`](./ROADMAP.md)), then `exec`s
  the runner.
- `sandbox-runner.ts`. Connects to OpenCode via the typed SDK,
  subscribes to its SSE stream, maps OpenCode events to
  `HermesEvent` (`event-mapper.ts`), bridges them to the DO over WS
  (`bridge.ts`).  On `review_ready` it does local prep only —
  `git add` / `git commit` / `git rev-parse HEAD` plus an
  agent-authored PR title+body — and emits
  `runner.ready_to_publish`.  The actual push + `POST /pulls`
  happen in the launcher (`publish.ts`); the sandbox never holds a
  write-scoped GitHub token.
- `bridge.ts`. WS reconnect loop, sequence-number resume, heartbeat
  every 10 s.

## 7. Launcher internals

`src/launcher/`:

- `server.ts`. HTTP API: `POST /sessions`, `GET /sessions/:id`,
  `DELETE /sessions/:id`, `POST /sessions/:id/resume`,
  `POST /sessions/:id/publish-pr` (publish chokepoint — see
  `publish.ts`), `GET /health`, `/mcp` (Slack/MCP entrypoint).
- `provision.ts`. The `Sandbox.create` → clone → `start.json` dance.
- `publish.ts`. The publish chokepoint.  Receives
  `{ branch, baseBranch, title, body, amendMode, ... }` from the
  DO, `Sandbox.connect`s to the running sandbox, adds a *one-shot*
  `hermes-publish` remote (write token inlined into the URL via
  the `envs` argument of `commands.run` — never written to
  `.git/config`), pushes `HEAD:<branch>`, removes the temp remote,
  and (fresh mode only) calls `POST /repos/:owner/:repo/pulls`.
  The temp remote is removed even on push failure so the sandbox
  never carries a token-bearing remote between commands.
- `sweeper.ts`. Boot-time orphan scan: every E2B sandbox tagged with
  a `metadata.hermes_session_id` is checked against the Worker; sandboxes
  whose session is terminal or unknown are destroyed.

The launcher is the *only* process holding the E2B API key + the
GitHub PAT. Neither ever ends up in the Worker bindings.

### Sandbox lifecycle rules

Every `Sandbox.create()` includes
`metadata: { hermes_session_id, hermes_repo }`; that's how the sweeper maps a
stray sandbox back to a session. Untagged sandboxes are never
touched.

| Trigger | Action |
|---|---|
| Session reaches `completed` / `failed` / `aborted` | sandbox killed by the per-session watcher (`watchSession()` in `server.ts`) |
| Session reaches `review_ready` | watcher auto-fires `POST /sessions/:id/create-pr` (skip with `CONTROL_PLANE_AUTO_PR=0`) |
| `DELETE /sessions/:id` | tracked sandbox killed; E2B scanned for matching `hermes_session_id` (post-restart cleanup); DO `/abort`'d |
| Launcher boots | startup sweep destroys any tagged sandbox whose session is terminal or unknown |
| Watcher hits the 24-h hard deadline | force-kill (runaway-job backstop; paused sandboxes are free) |
| Provisioning fails | sandbox killed, DO aborted |

## 8. E2B template

`infra/e2b/build-template.ts` builds the `control-plane-runner`
template:

- Base: `node:22`.
- Globally installs `opencode-ai`.
- Bundles supervisor + runner with `Bun.build({ target: "node" })`
  into `/opt/control-plane/{supervisor.js,runner.js}`.
- `setStartCmd("node /opt/control-plane/supervisor.js > /var/log/hermes-supervisor.log 2>&1")` —
  so on every sandbox boot the supervisor is *already running* when
  the launcher drops `start.json`.
- Readiness check: `ss -Htuln sport = :4096` (OpenCode is up).

E2B templates are **per-account** resources. Each self-hoster runs
`bun run template:build` against their own `E2B_API_KEY`; there is
no public registry. `E2B_TEMPLATE` defaults to the alias
`control-plane-runner` (set in `wrangler.jsonc` `vars`), so as long
as you keep the alias name, you don't need to pin to a template ID
per deploy.

## 9. Security model

| Credential | Where it lives | Why not somewhere else |
|---|---|---|
| `E2B_API_KEY` | launcher env only | Worker can't drive E2B SDK; key would be dead weight. |
| `GITHUB_WRITE_TOKEN` | **launcher env only — never enters the sandbox** | Only the launcher's `POST /sessions/:id/publish-pr` handler uses it (passed to `git push` via the `envs` arg of `commands.run` for a single command; the temp remote is removed immediately after). Sandbox-side `git push origin` returns 403 by construction. |
| `GITHUB_READ_TOKEN` | launcher env, baked into `.git/config` of the per-session sandbox | Lets the agent `git fetch` and lets `provision.ts` `git clone`. Contents:Read only, so the agent cannot push or open PRs even if it exfiltrates the token from `.git/config`. |
| `ZAI_API_KEY` | launcher env, forwarded into the sandbox via `start.json` | Runner needs it to drive OpenCode. |
| `runnerToken` | minted in the DO, dropped in `start.json` for the runner, validated on WS connect | Avoids broad credentials inside the sandbox; one token per session, useless after the session ends. |

The Worker holds no long-lived credentials (the only secrets in
Worker env are the OAuth-callback secrets once
[`ROADMAP.md §14`](./ROADMAP.md) multi-user OAuth ships).

## 10. Testing

Three layers, fastest to slowest:

| Layer | File | Real things |
|---|---|---|
| Unit + in-process E2E | `tests/` (vitest) | Real `SessionDurableObject` class, hand-rolled `cloudflare:workers` shim for `ctx`/WS/storage. Offline. |
| Real workerd + fake runner | `scripts/e2e-real.ts` | Real Worker via `bunx wrangler dev`, fake runner over HTTP/WS. |
| Full system | `scripts/e2e-full.ts` | Real launcher + real E2B sandbox + real OpenCode + real GitHub PR. Costs LLM credits. |

`scripts/sandbox-debug.ts <sandboxId>` is the incident-response
helper — it SSHes into a live E2B sandbox and dumps `start.json`,
processes, supervisor + runner logs, the cloned repo, and the
OpenCode port.
