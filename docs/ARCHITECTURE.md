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
4. **Launcher** `git clone`s the repo inside the sandbox using the
   user's PAT (`GITHUB_USER_TOKEN`), bakes the PAT into
   `.git/config` for the agent's own `git push` later, then drops
   `/opt/control-plane/start.json` with the per-session env (runner
   token, Worker WS URL, PAT, model). The PAT only lives inside the
   ephemeral sandbox; it is never persisted by the Worker.
5. **Supervisor** (already running in the snapshot via `setStartCmd`)
   sees the file appear and `exec`s the runner.
6. **Runner** dials the Worker's `/sessions/:id/runner?token=…` over
   WS, registers, and receives the first `agent.prompt` command.
7. **Runner** drives OpenCode, streams `agent.message.delta` /
   `tool.call` / `tool.result` events back through the DO; the DO
   broadcasts them to all subscribed clients on `/sessions/:id/stream`.
8. On `review_ready`, the launcher auto-fires the DO's `/create-pr`
   (configurable via `CONTROL_PLANE_AUTO_PR`). The runner pushes the
   branch using the user's PAT, opens the PR, emits `pr.created`, the
   DO transitions to `completed`.
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
  (`bridge.ts`), and on `review_ready` does `git push` + opens the
  PR using the user's PAT.
- `bridge.ts`. WS reconnect loop, sequence-number resume, heartbeat
  every 10 s.

## 7. Launcher internals

`src/launcher/`:

- `server.ts`. HTTP API: `POST /sessions`, `GET /sessions/:id`,
  `DELETE /sessions/:id`, `POST /sessions/:id/resume`,
  `GET /health`, `/mcp` (Slack/MCP entrypoint).
- `provision.ts`. The `Sandbox.create` → clone → `start.json` dance.
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
| `GITHUB_USER_TOKEN` | launcher env, scoped per-repo, baked into `.git/config` of the per-session sandbox | The runner needs it to `git push` + open the PR. PAT is short-lived and per-session. |
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
| Real workerd + fake runner | `scripts/e2e-real.ts` | Real Worker via `bunx wrangler dev`, fake runner over HTTP/WS. 37 checks. |
| Full system | `scripts/e2e-full.ts` | Real launcher + real E2B sandbox + real OpenCode + real GitHub PR. Costs LLM credits. |

`scripts/sandbox-debug.ts <sandboxId>` is the incident-response
helper — it SSHes into a live E2B sandbox and dumps `start.json`,
processes, supervisor + runner logs, the cloned repo, and the
OpenCode port.
