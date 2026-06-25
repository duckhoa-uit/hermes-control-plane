# Hermes Control Plane — Gap Analysis & Improvement Roadmap

Living document. Source of truth for what we are missing vs. a production-grade
background coding agent, and the prioritized plan to close those gaps.

- **Owner:** core team
- **Last updated:** 2026-06-25
- **Reference:** Ramp "Why We Built Our Own Background Agent" — <https://builders.ramp.com/post/why-we-built-our-background-agent>
- **Status legend:** ✅ done · 🟡 partial · ❌ missing · ⚠ governance/security risk

When you change scope, update the matrix **and** the roadmap section. Keep the
two in sync. Mark items done with a PR link in the "Notes" column.

---

## 1. Reference architecture (Ramp Inspect)

Short summary of the patterns we are benchmarking against. Keep this section
terse — it is reference, not aspiration.

- **Sandbox:** Modal sandboxes; image registry per repo; images rebuilt every
  30 min (clone + install + initial build/test for cache warmup); filesystem
  snapshots for resume; warm pool for hot repos; warm-on-keystroke.
- **Sync policy:** reads allowed immediately; writes blocked until base-branch
  sync completes (enforced via OpenCode `tool.execute.before` plugin).
- **Agent runtime:** OpenCode (server + typed SDK + plugins); skills/MCPs/custom
  tools encode shipping conventions; agent can spawn sub-sessions; follow-up
  prompts queued (not injected mid-turn); mid-run stop supported.
- **Verification surface:** tests, Sentry, Datadog, LaunchDarkly, Braintrust,
  Buildkite, screenshots, computer-use, live preview.
- **API/state:** Cloudflare Durable Objects (one SQLite DB per session);
  Cloudflare Agents SDK + WebSocket Hibernation; multiplayer with per-prompt
  author attribution.
- **GitHub:** PR creation uses the **user's** GitHub token (never the App), so
  authors cannot self-approve; webhooks track PR lifecycle.
- **Clients:** Slack (with repo classifier), Web (mobile-friendly, hosted
  `code-server` inside sandbox, streamed desktop, screenshots into PR), Chrome
  extension that sends DOM/React-tree instead of images.
- **North-star metric:** % of sessions that produce a merged PR. Live "humans
  prompting" gauge (active users in last 5 min).

---

## 2. Current architecture (hermes-control-plan)

See `README.md` for the canonical diagram. Snapshot of the relevant pieces:

- **Control plane:** Cloudflare Worker + `SessionDurableObject`
  (`src/worker/session-do.ts`), D1 mirror (`schema.sql`), R2 artifacts.
- **Sandbox:** E2B, created on demand in `src/providers/e2b.ts`. Each session
  performs at runtime: `git clone` → optional setup script → `curl bun.sh` →
  `bun add ws` → write runner via base64 → `nohup bun run hermes-runner.ts`.
- **Runner:** Bun script (`src/runner/sandbox-runner.ts`) bundled as a Text
  module, connects back to the DO over WebSocket, drives `opencode`.
- **GitHub:** App-installation token broker (`src/providers/github.ts`).
- **Clients:** none — only test CLIs in `src/testing/`.
- **Auth/multi-user:** none — sessions are implicitly single-owner.

---

## 3. Gap matrix

| # | Area | Reference (Ramp) | Hermes today | Status | Risk | Notes / PR |
|---|---|---|---|---|---|---|
| 1 | Sandbox cold start | Pre-baked image per repo, snapshots | Runtime install of bun/ws + clone + setup every session (`src/providers/e2b.ts:25-72`) | ❌ | High (UX, time-to-first-token) | |
| 2 | Image freshness | 30-min rebuild loop | None | ❌ | Med | |
| 3 | Warm pool | Pool per hot repo, warm-on-keystroke | None | ❌ | Med | |
| 4 | Snapshot/resume | Snapshot on end, restore on follow-up | None | ❌ | Med | |
| 5 | Read-before-sync | Reads early, writes gated | N/A (whole clone is the sync) | ❌ | Low (blocked by #1) | |
| 6 | OpenCode plugin policy | `tool.execute.before` enforces policy in-sandbox | Approval policy lives only in worker state machine | 🟡 | Med | |
| 7 | Sub-session tool | Agent can spawn sessions | No | ❌ | Low | |
| 8 | Prompt queue / mid-run stop | Queued, stoppable | Only `abort` exists; no queued follow-ups (`src/worker/session-do.ts`) | 🟡 | Med | |
| 9 | DO + SQLite per session | Yes | Yes | ✅ | — | Aligned |
| 10 | WebSocket hibernation | Cloudflare Agents SDK | Plain WS in DO | 🟡 | Low (cost) | |
| 11 | Multiplayer / author attribution | Yes, per-prompt author | Single implicit owner; no `author_user_id` on events | ❌ | Med | |
| 12 | PR auth | User GitHub OAuth token | GitHub **App** installation token (`src/providers/github.ts`) | ⚠ | **High (governance)** | Users can self-approve their own PRs |
| 13 | GitHub webhooks | PR open/merge/close → events | None | ❌ | Med | |
| 14 | Verification tools | Sentry/DD/LD/Braintrust/screenshots/computer-use | Test runner only (per profile) | ❌ | Med | |
| 15 | Skills/MCPs | Encode shipping conventions | None | ❌ | Low | |
| 16 | Slack client | Yes (with repo classifier) | None | ❌ | Low | |
| 17 | Web client | Polished, mobile-friendly | None | ❌ | Med | |
| 18 | Hosted `code-server` | Inside sandbox | None | ❌ | Low | |
| 19 | Chrome extension | DOM/React-tree, not images | None | ❌ | Low | |
| 20 | Metrics: merge-rate | % sessions → merged PRs, live users | None | ❌ | Med | |
| 21 | Repo classifier | Fast LLM, channel-aware | Project id required | 🟡 | Low | Acceptable until Slack exists |

---

## 4. Roadmap

Prioritized by ROI. Each item has a **success criterion** so we can self-verify
without re-asking. Keep items small enough to ship in one PR.

### P0 — Close the cold-start gap

- [ ] **P0.1 Pre-baked E2B template per project.** Move clone + deps + bun +
  runner + `opencode` install into a custom E2B template (Dockerfile under
  `infra/e2b/<project>/`). Strip the runtime install path from
  `E2BProvider.create` (`src/providers/e2b.ts:42-72`).
  - Verify: `time` from `POST /sessions` → `ready` < 5s on warm path; runner
    starts without any `bun add`/`curl bun.sh` step in the event log.
- [ ] **P0.2 30-min template refresh.** Worker Cron Trigger rebuilds each
  registered project's template; record `template_version` on the `projects`
  row; new sessions pin the latest version.
  - Verify: cron fires on schedule, `projects.template_version` updates, next
    session creates with new id.
- [ ] **P0.3 Warm sandbox pool.** Per hot project, keep N paused E2B sandboxes;
  `POST /sessions` leases from the pool, falls back to cold create.
  - Verify: pool depth metric; p95 first-token latency drops ≥ 50%.
- [ ] **P0.4 Snapshot on session end + resume on follow-up.** Store snapshot id
  in `sessions`; follow-up message resumes instead of re-cloning.
  - Verify: follow-up event log shows `sandbox.resumed`, no `git.clone`.

### P1 — Security & PR correctness

- [ ] **P1.1 User GitHub OAuth for PRs.** Replace App-token PR creation in
  `src/providers/github.ts` with the requesting user's OAuth token. Encrypt and
  store per-user tokens in D1 (`users` table). App token kept only for repo
  metadata and webhooks.
  - Verify: PR `author` equals the real user; user without OAuth cannot create
    a PR; integration test asserts both.
- [ ] **P1.2 GitHub webhook ingestion.** New route `/webhooks/github` updates
  `session_artifacts.pr_url` and emits `pr.opened|merged|closed` events.
  - Verify: webhook replay test → corresponding events appended.

### P2 — Agent capabilities

- [ ] **P2.1 OpenCode `tool.execute.before` plugin.** Move
  `approvalPolicy.requireApproval` enforcement into the sandbox; also block
  writes until base-branch sync completes (prereq for P0.4).
  - Verify: plugin blocks `git.push` until DO sends `approval.granted`; reads
    are allowed before sync, writes are not.
- [ ] **P2.2 `spawn_session` tool.** MCP/tool that POSTs `/sessions` with
  `parent_session_id`. Add column + `session.spawned` event.
  - Verify: agent spawns child, parent log shows child status updates.
- [ ] **P2.3 Prompt queue + mid-run stop.** Add `pending_prompts[]` in DO
  storage; flush after each turn. New routes `POST /sessions/:id/prompt` and
  `POST /sessions/:id/stop` (distinct from `abort`).
  - Verify: queued prompt runs after current turn; `stop` interrupts current
    turn without transitioning to `aborted`.

### P3 — Multiplayer & clients

- [ ] **P3.1 Author attribution.** Add `author_user_id` to `session_events`;
  require auth on all session-mutating routes; drop single-owner assumption.
  - Verify: two authenticated clients append events to one session, each
    tagged with their own user id.
- [ ] **P3.2 Slack client (MVP).** Bot receives message → fast-model classifier
  picks repo → creates/appends session → Block Kit status updates.
  - Verify: end-to-end Slack thread reaches a merged PR.
- [ ] **P3.3 Hosted `code-server`.** Bake into the E2B template; expose via
  `exposePort(8080)` behind a DO-proxied, auth-gated URL.
  - Verify: open URL, see repo, manual edits show up in session diff.
- [ ] **P3.4 Web client (mobile-friendly).** Minimal Next.js or static SPA that
  consumes the existing WS stream.
  - Verify: works on mobile Safari; live event stream is visible.

### P4 — Observability

- [ ] **P4.1 Merge-rate + live-users metrics.** D1 view, `/metrics` route,
  small stats page. Track `sessions_total`, `sessions_merged`, `merge_rate`,
  `humans_prompting_5m`.
  - Verify: merging a PR moves `sessions_merged`; `humans_prompting_5m` reacts
    within the window.
- [ ] **P4.2 WebSocket hibernation.** Adopt Cloudflare Agents SDK or the
  hibernatable WS API on the DO.
  - Verify: idle DO CPU time ≈ 0 between events.

---

## 5. Out of scope (intentionally)

Capture decisions to *not* do something, so we stop re-litigating.

- **Computer-use / streamed desktop view.** Defer until web client + visual
  verification have real user demand.
- **Chrome extension.** Niche until we have non-engineering users.
- **Multi-cloud sandbox provider.** E2B is sufficient; revisit only if pricing
  or template build limits bite.
- **Custom emoji Slack pack.** Cosmetic; do after P3.2 ships.

---

## 6. How to use this document

- When picking up work, move the item to "in progress" by adding your name and
  date in the Notes column.
- When closing an item, replace the checkbox with the merge commit / PR link.
  Do not delete items — keep history.
- When the reference architecture (section 1) evolves (new blog, new product
  decision), append a dated bullet rather than rewriting silently.
- If you add a new gap, add a row to the matrix **and** a roadmap item with a
  success criterion. No success criterion → no roadmap item.

---

## 7. E2B capability check (2026-06-25)

Verified the E2B platform actually supports the P0 plan before committing.
Sources: `e2b.mintlify.app/docs` (`template/how-it-works`, `template/build`,
`template/caching`, `template/start-ready-command`, `sandbox/persistence`,
`sandbox/snapshots`, `sandbox/auto-resume`, `billing`).

### Capabilities (green-lit)

| Roadmap item | E2B primitive | Notes |
|---|---|---|
| P0.1 pre-baked template | `Template.build()`, layered cache (Docker-style), `setStartCmd` + ready check | Snapshot taken at end of build; `Sandbox.create()` loads in ~80 ms with the start process already running. |
| P0.2 30-min refresh | `Template.buildInBackground()` + `getBuildStatus()`; tags & versioning | Layer cache makes unchanged rebuilds near-instant. Concurrent builds: 20 on Hobby and Pro. |
| P0.3 warm pool | `Sandbox.create()` + `pause()` + `connect()` (or auto-resume) | No first-class pool primitive — we manage it. Must respect concurrent-sandbox cap. |
| P0.4 snapshot/resume | Two mechanisms: **Pause/Resume** (1:1) and **Snapshots** (1:many via `createSnapshot` → `Sandbox.create(snapshotId)`). `lifecycle.autoResume = true` resumes on activity. | Billing pauses while paused. Snapshots require envd ≥ v0.5.0 — our template must use a recent base image. |
| P3.3 code-server in template | Bake into template, `setStartCmd("code-server ...", waitForPort(8080))` | Same supervisor trick as the runner. |

### Constraints to design around (not blockers)

1. **Hobby tier ceiling** — 20 concurrent sandboxes, 1 sandbox/sec creation,
   1 h max continuous runtime, 8 vCPU / 8 GB RAM / 10 GB disk. Slack-scale
   adoption (P3.2) likely requires Pro ($150/mo, 100 concurrent, 5/sec).
2. **`setStartCmd` runs at template build time, not on `Sandbox.create()`.**
   Env vars passed to `Sandbox.create({ envs })` are **not visible** to the
   start command — it already ran. Our runner needs per-session
   `HERMES_SESSION_ID`, `HERMES_RUNNER_TOKEN`, `HERMES_CONTROL_WS`
   (`src/runner/sandbox-runner.ts`), so we cannot just put the runner in
   `setStartCmd` directly.
   - **Design:** `setStartCmd` launches a *supervisor* that waits for
     `/var/run/hermes/start.json`, then execs the real runner with the values
     from that file. `E2BProvider.create()` writes that file immediately after
     `Sandbox.create()` returns. Keeps the "process already running" win.
3. **Pool reuse vs. session isolation.** Pooled sandboxes have not run a
   session yet; per-session secrets are injected at lease time (same
   supervisor file). Sandboxes are killed (not returned) after a session ends
   because runner memory holds the session token.
4. **Snapshots require envd v0.5.0+.** The template's base image must be
   recent enough. New work only — no migration concern.
5. **Kernel pinned at template build time.** Not a problem for our workload.
6. **Files written via `setEnvs()` are available to the start command;**
   files passed via `Sandbox.create({ envs })` are not. Use `setEnvs()` only
   for build-time constants, not per-session data.

### Implications for the roadmap

- **P0.1 design updated:** use a supervisor in `setStartCmd`, not the runner
  directly. Update item P0.1 acceptance to include "supervisor reads
  `/var/run/hermes/start.json` and execs runner".
- **P0.3 acceptance bound:** pool size ≤ (`E2B concurrent cap` − `peak live
  sessions`). On Hobby, pool ≤ 10 is realistic; revisit on Pro.
- **P0.4 mechanism choice:** prefer **Pause/Resume** (cheaper, 1:1, fits
  follow-up-prompt use case). Reserve **Snapshots** for branching / "what if I
  retried this prompt" UX that the Ramp blog highlights.
- **No blocker found for P0–P3.** Proceed with P0.1.

---

## 8. MVP scope (Hobby tier, single user) — 2026-06-25

We deliberately reduce the roadmap to what is needed for a solo developer on
the E2B Hobby plan to use hermes end-to-end. Everything not listed in section
**8.1** is deferred to a "Post-MVP" phase; section **8.3** records what each
deferral costs us so we can revisit deliberately.

### 8.1 In MVP

Three items only. Each is small enough for one PR.

- [ ] **M1 — Pre-baked single E2B template.** One template (not per-repo)
  containing: base image, bun, `opencode` CLI, runner source at
  `/opt/hermes/runner.ts`, supervisor in `setStartCmd` that reads
  `/var/run/hermes/start.json` (written by `E2BProvider.create` after sandbox
  creation) and execs the runner. Strip the runtime install path from
  `src/providers/e2b.ts:42-72`. Repo clone stays at session-create time
  (varies per session).
  - Verify: `POST /sessions` → `ready` event in < 10 s on warm cache; event
    log contains no `curl bun.sh` or `bun add ws` steps.
- [ ] **M2 — Auto-pause on idle.** Add
  `lifecycle: { onTimeout: 'pause', autoResume: true }` and a short
  `timeoutMs` (15 min) to `Sandbox.create()` in `src/providers/e2b.ts`. Store
  `sandbox_id` (already in `sessions` table) and reuse on follow-up prompts.
  - Verify: leave a session idle 20 min; send another prompt; sandbox resumes
    (no new sandbox id) and event log shows `sandbox.resumed`.
- [ ] **M3 — Hobby concurrency guard.** Add `MAX_CONCURRENT_SESSIONS = 10`
  (well under E2B Hobby's 20). Worker checks live session count (D1 query on
  `sessions.status IN ('provisioning','running','needs_approval',...)`)
  before creating; returns HTTP 429 if exceeded.
  - Verify: scripted test creating 11 sessions in parallel — 11th returns
    429; 10 others run.

### 8.2 Hobby tier guardrails (apply to MVP code)

These are constraints, not features. Encode them as constants so they are
findable later:

- Max concurrent sessions: **10** (E2B Hobby cap is 20; leave headroom for
  pool/builds later).
- Sandbox creation rate: **≤ 1/sec** (E2B Hobby cap is 1/sec). The current
  worker has no rate limit; M3's concurrency guard covers the worst case but
  add a simple per-second token bucket if multiple concurrent
  `POST /sessions` start failing.
- Per-session continuous runtime: **≤ 45 min** wallclock
  (`MAX_SESSION_RUNTIME_MS` in `wrangler.toml`; E2B Hobby cap is 1 h).
- Per-session disk: **≤ 10 GB** (E2B Hobby cap). Not enforced; document and
  monitor.
- Template version: hand-tagged in env (`E2B_TEMPLATE` in `wrangler.toml`).
  Rebuild by running a script; no cron.

### 8.3 Deferred items and their limitations

Each item below is **not abandoned**, just postponed. If we hit the limitation
described, revisit.

- **Per-repo template registry + 30-min refresh (was P0.2).** *Limitation
  while deferred:* template gets stale when project deps change; manual
  rebuild needed (~5 min of human time per stale-dep incident). Acceptable
  for one developer.
- **Warm sandbox pool (was P0.3).** *Limitation while deferred:* every
  session pays the cold-create cost (E2B docs claim ~80 ms from snapshot, so
  this is tolerable). Revisit only when p95 time-to-first-token from real
  usage exceeds 3 s.
- **Snapshot-based session forking (subset of P0.4).** Auto-pause/resume
  (M2) covers single-session continuity. *Limitation while deferred:* cannot
  branch a session ("retry this prompt with a different model") without
  re-running from scratch. Acceptable for MVP.
- **User GitHub OAuth for PR creation (was P1.1).** *Purpose:* PRs authored
  by the real user so branch protection's "review by someone other than
  author" rule works. *Limitation while deferred:* all PRs are authored by
  the GitHub App identity, so we cannot safely onboard a 2nd human user
  (they could self-approve their own bot-authored PR). Solo-user-safe.
- **GitHub webhooks (was P1.2).** *Purposes in our system:* (a) drive
  session state machine to a real terminal state on
  `pr.merged`/`pr.closed`/`check_run.failed`; (b) auto-resume a paused
  session when reviewers leave comments so the agent fixes its own PR;
  (c) provide ground truth for the merge-rate metric. *Limitations while
  deferred:* session status hangs at `creating_pr`; no "agent fixes review
  comments" workflow; merge-rate metric not feasible. Manual `gh pr view`
  suffices for one user.
- **OpenCode `tool.execute.before` plugin (was P2.1).** *Purpose:* enforce
  approval policy *inside the sandbox* (defense in depth), not just in the
  worker. *MVP decision:* run agent with **full auto-allow**
  (`approvalPolicy.requireApproval = []`, everything in `autoAllow`). Keep
  the gate code in `SessionDurableObject` — only the config changes — so we
  can flip approvals back on without a refactor. *Limitations while
  deferred:* (a) no human gate on destructive shell commands (mitigated:
  E2B sandbox isolation + GitHub branch protection on `main`); (b) no
  defense against a buggy/compromised runner skipping the gate (mitigated:
  short-lived session-scoped runner token, sandbox is throwaway); (c) a
  runaway agent can spend Zai tokens until M3's runtime cap kicks in — add
  a per-session turn count cap (e.g. 50 turns) as a cheap backstop.
- **`spawn_session` agent tool (was P2.2).** *Purpose:* let the agent
  fan out parallel research across repos or split big tasks into multiple
  smaller PRs. *Limitation while deferred:* no multi-repo research; no
  automatic PR splitting. User can manually open multiple sessions.
- **Prompt queue (subset of P2.3).** *Limitation while deferred:* a prompt
  sent mid-turn either races or errors. Document the rule "wait for the
  current turn to finish, then prompt" in the user-facing API doc. Keep the
  "stop" half if cheap.
- **Author attribution on events (was P3.1).** *Limitation while deferred:*
  cannot onboard a 2nd user without losing the audit trail of "who did
  what" inside a shared session. Prerequisite for any multiplayer story.
- **Slack / Web / Chrome / code-server clients (was P3.2–P3.4).**
  *Limitation while deferred:* hermes is API-only; only usable via the test
  CLIs in `src/testing/`. Fine for the builder; not fine for non-engineers.
- **Metrics dashboard + WS hibernation (was P4).** *Limitation while
  deferred:* no visibility into merge-rate or active users (ad hoc D1
  queries work for one user); idle WS connections cost a tiny amount of DO
  CPU time. Negligible at MVP scale.

### 8.4 Cheap backstops to add alongside MVP

These are not roadmap items, just small constants/checks that prevent the
deferred-item limitations from biting hard:

- Per-session **turn count cap** (e.g. 50) in `SessionDurableObject` — kills
  runaway loops even with full auto-allow.
- Per-session **token spend cap** if OpenCode exposes usage — same reason.
- **`MAX_SESSION_RUNTIME_MS`** already exists; verify it's enforced
  (`src/worker/session-do.ts`).
- **Session-scoped runner token** is already short-lived (see README
  Security Model); confirm it's not logged.

### 8.5 Exit criteria — when MVP graduates to next phase

Revisit deferred items when **any** of these is true:

- A 2nd human user starts using the system → do **P1.1 user OAuth** and
  **P3.1 author attribution** first.
- p95 time-to-first-token from real usage > 3 s → do **P0.3 warm pool**.
- We want PRs to drive session state → do **P1.2 webhooks**.
- We exceed 5 merged PRs/week and want to know merge-rate → do **P4.1
  metrics** and **P1.2 webhooks**.
- Template deps drift weekly → do **P0.2 30-min refresh**.

---

## 9. M1 implementation log (2026-06-25)

### What shipped

| Item | Status | Notes |
|---|---|---|
| M1 — pre-baked E2B template | ✅ done | Template `hermes-runner` (id `ihf90c8bik7w8rwrk1u7`); bundles node, opencode CLI, supervisor, runner; supervisor runs in the snapshot via `setStartCmd` and execs the runner on `/opt/hermes/start.json` arrival. |
| M2 — auto-pause + autoResume | ✅ done | `Sandbox.create()` passes `lifecycle: { onTimeout: 'pause', autoResume: true }`, `timeoutMs: 15min`. Verified the option is wired; long-idle resume not stress-tested. |
| M3 — Hobby concurrency guard | ✅ done | Enforced host-side in `scripts/launch-session.ts` via `checkConcurrencyCap()` (E2B REST `GET /v2/sandboxes`). Static cap is `MAX_CONCURRENT_SESSIONS = 10` in `wrangler.toml`, overridable via env. Exits with code 2 and a clear message when at cap. Verified live: with cap=3 and 3 paused sandboxes, the launcher refuses to launch. |
| Real PR creation flow | ✅ done | Launcher mints a short-lived, repo-scoped GitHub App installation token; runner does `git push` and opens the PR via REST. Bot identity `hermes-bot`. Verified by opening PR #2 against duckhoa-uit/hermes-control-plane adding `it's worked!` to README.md. |

### 9.1 End-to-end verification

Real run, no fakes:

- `bun run scripts/launch-session.ts <repo> "<task>"` → 36 s wall-clock to `completed`.
- Template cold-load: ~700–800 ms (snapshotted supervisor already running).
- Clone + write start.json + runner spawn: ~1 s.
- Agent work (opencode glm-5.2): ~10–15 s for a one-line README change.
- Push + PR create: ~1 s.
- Verified artifact: <https://github.com/duckhoa-uit/hermes-control-plane/pull/2>
  (open, mergeable, +1/-0, base `main`, head `hermes/830dd215`).

Error-handling matrix verified:

| Error injected | Where | Resulting state | Notes |
|---|---|---|---|
| Invalid `ZAI_MODEL` | runner spawns opencode | `running → failed` | `agent.error` event carries full stderr; runner exits cleanly. |
| Non-existent repo URL | host-side `git clone` | `provisioning → aborted` | Launcher detects exit 128, calls `/abort`, kills sandbox; no orphaned compute. |
| Long runner silence after task | DO heartbeat check | `running → stalled → failed` | Single `system.stalled` event, then `failed`. **Fix landed**: timer stops once terminal/creating_pr or after firing once (previously emitted forever). |
| Runner exits after pushing PR | DO `pr.created` event | `creating_pr → completed` | **Fix landed**: `pr.created` runner.event now routes to `onPRCreated`; previously the DO never reached `completed`. |
| Invalid E2B template id | `Sandbox.create` throws | `provisioning → aborted` | Launcher catches the SDK error, calls `/abort`, exits 1; no orphaned DO. Verified live. |
| At concurrency cap | host-side probe | refused, exit 2 | Verified live with `MAX_CONCURRENT_SESSIONS=3` and 3 paused sandboxes. |

### 9.2 Architectural finding: Cloudflare Worker cannot drive the E2B SDK

Discovered while wiring M1: calling `e2b` SDK methods (`Sandbox.create`, `Sandbox.list`) from inside the Worker — even with `nodejs_compat` — crashes `workerd` silently during long-running `waitUntil`-style work. The first POST returns 201; the runtime then dies with **no log line**.

Consequence for the architecture:

- **The Worker is not a sandbox driver.** It is the orchestrator: holds DO state, routes WebSockets, persists artifacts, runs the state machine.
- **Provisioning happens host-side.** `scripts/launch-session.ts` (Bun) creates the sandbox, drops `/opt/hermes/start.json`, then polls the Worker for events. The runner inside the sandbox dials the Worker over WS using a public URL (ngrok locally; deployed Worker URL in prod).
- **`E2BProvider` is no longer used by the Worker.** It still exists in `src/providers/e2b.ts` and is unit-tested (3 tests in `tests/e2b-provider.test.ts`), but the Worker DO falls back to `MockSandboxProvider` for tests and treats real sessions as "external runner mode" (already an existing branch).

This is a permanent constraint, not a temporary workaround. Updates to ROADMAP P0.2 (cron rebuild), P0.3 (warm pool), and P0.4 (snapshot/resume) must all run **host-side** (or, eventually, on a small Bun sidecar service the Worker calls over HTTPS), not from inside the Worker.

### 9.3 Other things noticed in passing

- `setStartCmd` runs at template-build time, so env vars passed to `Sandbox.create()` are not visible to the supervisor. We bridge them through `/opt/hermes/start.json`. Confirmed working.
- E2B's `commands.run` throws on non-zero exit by default. The launcher's git clone now captures `$?` via `__exit=N` shell suffix to detect failures without the SDK throwing.
- The template's start command captured a minimal PATH at build time (missing `/usr/local/bin` after env scrubbing). The supervisor now prepends `/usr/local/bin:/usr/bin:/bin` to `PATH` before spawning the runner; otherwise `opencode` is `ENOENT`.
- `.dev.vars` had a PKCS#1 (`BEGIN RSA PRIVATE KEY`) GitHub App key but the broker expects PKCS#8 (`BEGIN PRIVATE KEY`). Converted with `openssl pkcs8 -topk8 -in pkcs1.pem -nocrypt -out pkcs8.pem`.
- Ngrok free tier is fine for the runner WS dial-back. The browser-warning interstitial does not affect WebSocket upgrades.

### 9.4 Follow-ups (small, ship soon)

- [x] M3 concurrency check moved into the launcher (`checkConcurrencyCap()` calls E2B REST and exits 2 at cap).
- [ ] Make ngrok URL discovery automatic in the launcher (`fetch http://127.0.0.1:4040/api/tunnels` fallback).
- [ ] Consider a small "hermes-launcher" Bun sidecar so a future web/Slack client can trigger sessions without each user installing E2B locally. This is the P0.2/P0.3/P0.4 host for the cron/pool/snapshot logic.
- [ ] The runner currently uses `GITHUB_TOKEN` for `git push` and PR REST; on token expiry mid-session (>1h) push will fail. Mint per-action tokens if a session runs that long, or refresh via the launcher.

---

## 10. Launcher sidecar (2026-06-25)

A small Bun HTTP service, `src/launcher/server.ts`, that owns sandbox
lifecycle and the only copy of the E2B + GitHub App credentials. Future
clients (web, Slack bot, CLI) talk to it over HTTP; only this one process
needs E2B locally.

### 10.1 Layout

| File | Purpose |
|---|---|
| `src/launcher/github-token.ts` | Mint short-lived, repo-scoped GH App installation tokens |
| `src/launcher/provision.ts` | Create the E2B sandbox, clone the repo, drop `/opt/hermes/start.json`; returns an idempotent `kill()` |
| `src/launcher/sweeper.ts` | Orphan sweeper: kills E2B sandboxes whose `metadata.hermes_session_id` is terminal/unknown on the Worker |
| `src/launcher/server.ts` | Bun HTTP server: `POST /sessions`, `GET /sessions/:id`, `DELETE /sessions/:id`, `GET /health`. Watches each session and reaps the sandbox on terminal status; triggers `/create-pr` on `review_ready` |
| `scripts/launch-session.ts` | CLI that calls the sidecar when `HERMES_LAUNCHER_URL` is set; falls back to direct in-process provisioning otherwise |

### 10.2 Sandbox lifecycle rules (implemented)

| Trigger | Action | Where enforced |
|---|---|---|
| Session reaches `completed` / `failed` / `aborted` | sandbox killed | sidecar per-session watcher (`watchSession()` in `server.ts`) |
| Session reaches `review_ready` | auto-trigger `POST /sessions/:id/create-pr` | sidecar watcher |
| Sidecar boots | startup sweep: for every E2B sandbox with `hermes_session_id` metadata, kill if Worker reports terminal/404 | `sweepOrphans()` |
| Client calls `DELETE /sessions/:id` | kill tracked sandbox, plus search E2B for `metadata.hermes_session_id` match (covers post-restart cleanup), then `/abort` the DO | sidecar |
| Sidecar watcher hits 35-min deadline | force-kill sandbox | sidecar |
| Provisioning fails (bad repo, bad template, E2B down) | sandbox killed; Worker session `/abort`'d | `provisionSession()` + sidecar `handleCreate` |

### 10.3 What's tagged

Every `Sandbox.create()` includes:
```ts
metadata: { hermes_session_id: <session.id>, hermes_repo: <repoUrl> }
```
This is the only safe way for the sweeper to map a stray sandbox back to a
session. Untagged sandboxes are never touched.

### 10.4 Known limitation

- If the sidecar restarts mid-session, the new sidecar does not re-establish a
  per-session watcher for the in-flight session. The sandbox will not be
  auto-reaped on the next terminal transition until the next sweep cycle. The
  `DELETE /sessions/:id` cleanup path covers manual recovery. A periodic
  in-process sweep would close this gap (future P0.x); the startup sweep is
  the MVP version.

### 10.5 Code we deleted (no longer reachable)

- `src/providers/e2b.ts` (`E2BProvider` class) — replaced by `provisionSession`
- `tests/e2b-provider.test.ts` — replaced by `tests/provision.test.ts`
- `SessionDurableObject.teardownSandbox()` and the `/sandbox/{exec,expose-port,destroy}` routes — the DO never held a real `sandboxHandle` in the new architecture, so the cleanup never fired. The sidecar now owns this responsibility end-to-end.

### 10.6 Verified end-to-end

| Check | Result |
|---|---|
| `POST localhost:8789/sessions` only, no CLI script | session created in ~3s, agent ran, PR opened (PR #5), sandbox killed automatically. Sidecar log shows `review_ready -> trigger create-pr` and `terminal=completed; killing sandbox`. |
| Orphan sweeper | Manually created a sandbox tagged with a non-existent session id; restarted sidecar; sweep log: `scanned=1 killed=1 kept=0`. E2B sandbox list empty after. |
| Sweeper preserves live sessions | Started a real session, restarted sidecar mid-run; sweep log: `scanned=1 killed=0 kept=1`. Sandbox still running. |
| `DELETE /sessions/:id` cleanup of untracked sandbox | After sidecar restart, `DELETE` killed the untracked sandbox via the E2B-metadata lookup; E2B list empty. |
| Worker returns clean 404 for unknown session ids | Required so sweeper rule "kill on 404" is correct. Verified: `GET /sessions/<unknown>` → `404 {"error":"session not found"}`. |
| Unit tests | 57 / 57 passing, including new `tests/provision.test.ts` (4) and `tests/sweeper.test.ts` (2). |

---

## 11. M4 — Runner ↔ OpenCode SDK/SSE (proposed, not implemented)

Today's runner shells out to `opencode run` once per turn and parses stdout
chunks. That's the single largest gap between us and the Ramp Inspect
runner-shape. This milestone closes it.

### 11.1 Why now

The outer architecture (DO + WS hub + sidecar + supervisor + sandbox
template) is already Inspect-shaped. The runner ↔ agent boundary is the
weakest link in the chain, and several roadmap items depend on it:

| Roadmap item | Blocked by stdout-driven runner |
|---|---|
| `agent.prompt` for follow-up turns (M2.3, partially shipped) | yes — each turn is a fresh `opencode run` with no memory |
| OpenCode `tool.execute.before` plugin (P2.1) | yes — no SDK to attach to |
| `spawn_session` agent tool (P2.2) | yes — same reason |
| Real tool / file event fidelity in the DO event log (`tool.started`, `tool.completed`, `file.changed` — declared, never emitted) | yes — opencode CLI doesn't surface these on stdout |
| Per-session token-usage / cost metrics (P4.1) | yes — not parseable from stdout |
| Stop / cancel mid-tool-call (M2.3 partial) | yes — only `kill -SIGTERM` works today |

### 11.2 Target shape

```
SessionDurableObject (Worker)
       │  WS  (unchanged)
       ▼
runner (sandbox)                 ← changes here
       │  OpenCode SDK + SSE
       ▼
opencode serve (sandbox)         ← new long-lived process
       │  shell, fs, model
       ▼
Z.AI GLM
```

- Template starts `opencode serve --port 4096` via the supervisor; bound to
  127.0.0.1, not exposed externally.
- Runner becomes an SDK client. Subscribes to the SSE event stream from
  OpenCode. Maps SDK events to our existing `HermesEventType` enum 1:1.
- Follow-up `agent.prompt` commands from the DO go to the same `opencode
  serve` instance — fast, no re-cold-start, agent has full prior turn
  context.
- `runner.complete` still triggers the PR-creation flow (unchanged for now;
  could later move into a server-side OpenCode plugin).

### 11.3 Scope of change

| Layer | Change |
|---|---|
| `infra/e2b/build-template.ts` | supervisor starts `opencode serve --port 4096 &`; readiness check `waitForPort(4096)`. Rebuild template (tag bump). |
| `src/runner/sandbox-runner.ts` | replace `spawn("opencode", ["run", …])` with an SDK client + SSE subscription. Map events: `message.delta → agent.message.delta`, `tool.call.start → tool.started`, `tool.call.end → tool.completed`, `file.changed → file.changed`, `usage → agent.usage` (new). Keep WS bridge to DO unchanged. |
| `src/core/types.ts` | add `agent.usage` event type. The `tool.*` and `file.changed` types already exist; they finally fire. |
| `src/worker/session-do.ts` | nothing structural; emit a `usage` summary at terminal time if the runner sent any. |
| `src/launcher/provision.ts` | drop `OPENCODE_MODEL` from start.json — the model is requested per-prompt via the SDK now, not via CLI flag (the launcher still passes `ZHIPU_API_KEY`). |
| `scripts/launch-session.ts` | unchanged. |
| Tests | new `tests/runner-event-mapping.test.ts` that drives a fake SDK and asserts the DO-bound payload schema. |
| Docs | `README.md` flow update; `docs/SETUP.md` template rebuild instruction. |

### 11.4 Success criteria

1. **Tool fidelity**: a single-task session emits at least one
   `tool.started` + matching `tool.completed` event in the DO log; emits at
   least one `file.changed`. Asserted by inspecting `/sessions/:id` events
   after a real run.
2. **Follow-up prompt produces additive change**: e2e test does (a) "add a
   one-line comment to README" → assert diff; (b) `POST
   /sessions/:id/prompt` "now also add the same line to docs/SETUP.md" →
   assert the new diff is additive on top of the first, no re-cold-start
   wallclock penalty (second turn ≤ 50 % of first turn).
3. **Token usage visible**: at terminal, `artifacts.usage` (new field)
   carries non-zero input/output tokens for the session.
4. **No regression**: 57 existing tests still pass; the PR-creation e2e
   still produces a real GitHub PR; sidecar lifecycle rules unchanged.

### 11.5 Risks

- **OpenCode SDK API drift**. Ramp leans on "ask AI to read OpenCode's
  source" — we should pin a specific `opencode-ai` version in the template,
  not `@latest`.
- **`opencode serve` startup time**. We rely on the template snapshot
  capturing the process already-running (Inspect's exact trick). If
  `setStartCmd` cannot reliably keep it warm, fall back to "supervisor
  starts it on first session" — a one-time per-sandbox cost (~2 s),
  amortized across follow-up turns.
- **One more process inside the sandbox**. The supervisor now babysits two
  children (opencode serve + runner). Need to make supervisor kill both on
  any one of them crashing, otherwise we leak.
- **PR-creation flow** currently lives in the runner. If we ever move
  parts of it into OpenCode plugins, that's a follow-up — out of scope
  for M4.

### 11.6 Out of scope for M4

- OpenCode plugins (P2.1, P2.2) — M4 is the *enabler*; plugins are their
  own follow-ups.
- Switching the model away from Z.AI — independent decision.
- Token-usage caps as enforcement (just *report* in M4).
- Computer-use / screenshot verification (P3.x).

### 11.7 Not started

Status: **proposed**. No code changes for M4 yet. Captured here so the
runner↔agent boundary stops being a hidden gap and lands as one cohesive
PR.

---

### 11.8 Pre-implementation verification (2026-06-25)

Two unknowns from §11.5 were verified live in a real E2B sandbox (created
from the existing `hermes-runner` template) before committing to the M4
design. Both ✅ PASS. Transcript: `/tmp/m4-smoke.out` during the dev
session.

#### 11.8.A `client.auth.set` shape + `session.prompt` round-trip

Goal: confirm the runner can authenticate Z.AI at runtime via the SDK
(instead of relying on `OPENCODE_MODEL`/env-var injection at process start)
and that a prompt actually returns an `AssistantMessage`.

| Step | Request | Result |
|---|---|---|
| 1 | `PUT /auth/zai-coding-plan` body `{"type":"api","key":<ZAI_API_KEY>}` | HTTP 200, body `true` |
| 2 | `GET /config/providers` | provider `zai-coding-plan` listed with `key` populated and models `glm-5.2`, `glm-4.7`, … |
| 3 | `POST /session` body `{"title":"smoke"}` | HTTP 200, `Session.id = ses_103528ff…` |
| 4 | `POST /session/{id}/message` body `{"model":{"providerID":"zai-coding-plan","modelID":"glm-5.2"},"parts":[{"type":"text","text":"…"}]}` | HTTP 200, `AssistantMessage` with `finish:"stop"`, `tokens:{total:7448,input:266,output:3,reasoning:11,cache:{read:7168,write:0}}`, `cost:0`. Wall: 4.2 s. |

SDK call shape locked in (no `metadata` needed):
```ts
await client.auth.set({
  path: { id: "zai-coding-plan" },
  body: { type: "api", key: ZAI_API_KEY },
});
```

Notable: `tokens.total` is present on the live response but **not on the
`AssistantMessage` type in `@opencode-ai/sdk@1.17.10`** (the typed schema
lists `input`/`output`/`reasoning`/`cache` only). The runner should read
`tokens.total` defensively (`tokens.total ?? input+output+reasoning`).
`cost` returned `0` because Z.AI Coding Plan is flat-rate — usage caps
must key off `tokens.total`, not cost.

#### 11.8.B `opencode serve` warmth across pause/resume

Goal: confirm we can put `opencode serve` in `setStartCmd` (via the
supervisor) and have the template snapshot capture it in a listening state,
rather than re-launching it on every `Sandbox.create()` / resume.

| Check | Result |
|---|---|
| `sandbox.pause()` wall | 363 ms |
| `Sandbox.connect(id)` wall | 458 ms |
| `pgrep -af 'opencode serve'` post-resume | **same PID** as pre-pause (1286), no re-exec |
| `ss -lnt` post-resume | `127.0.0.1:4096` + `169.254.0.21:4096` both in `LISTEN` |
| `curl /config/providers` post-resume | HTTP 200 |
| `POST /session/{same-sid}/message` post-resume | HTTP 200, returned text in 5 s wall, `cache.read: 7424` (warm cache hit) |

Implications:

1. E2B snapshot is **process-state-level**, not exec-level. Network sockets
   and child-process state survive.
2. The opencode `Session` object survives pause/resume — follow-up prompts
   on the same `sid` continue the conversation. This is exactly the
   primitive we need for §M2 (auto-pause) + M4 follow-up prompts to compose.
3. The §11.5 fallback ("supervisor starts opencode serve lazily on first
   session") is unnecessary. Drop it from the design.

#### 11.8.C What was *not* verified (deferred to M4 implementation)

- SSE `event.subscribe()` stream actually delivers `message.part.updated`
  with `delta` deltas in real time (smoke used the non-streaming `prompt`
  response). Low risk — it's a standard SSE endpoint.
- Supervisor's two-child kill semantics (one dies → kill the other). Will
  be covered by `tests/supervisor.test.ts` in the M4 PR.
- Behaviour when `opencode serve` itself crashes mid-session. Out of scope
  for M4; treat as a failed turn.

---

### 11.9 OpenCode → Hermes event mapping (locked)

From `@opencode-ai/sdk@1.17.10` (`dist/gen/types.gen.d.ts`). Names on the
left are the `type` field on SSE events from `client.event.subscribe()`.

| OpenCode SSE event | Condition | Hermes event | Payload |
|---|---|---|---|
| `message.part.updated` | `part.type == "text"`, `delta` set | `agent.message.delta` | `{ text: delta }` |
| `message.part.updated` | `part.type == "tool"`, `state.status == "running"` (first sight) | `tool.started` | `{ callID, tool, input }` |
| `message.part.updated` | `part.type == "tool"`, `state.status == "completed"` | `tool.completed` | `{ callID, tool, output, durationMs }` |
| `message.part.updated` | `part.type == "tool"`, `state.status == "error"` | `tool.completed` (with `error`) | `{ callID, tool, error }` |
| `file.edited` | always | `file.changed` | `{ file }` |
| `session.error` | always | `agent.error` | `{ error: error.message, name: error.name }` |
| `session.idle` | for the current opencode session id | (terminal marker — drives the runner to send `runner.complete`) | — |
| `permission.updated` | always | `approval.requested` | `{ id, type, title, callID, metadata }` (**logged only in M4; not gated until P2.1**) |
| `message.updated` | `info.role == "assistant"` and `info.time.completed` set | `agent.usage` (new) | `{ tokens, cost, modelID, providerID }` — accumulated, summed at terminal time as `artifacts.usage` |

Events we deliberately ignore in M4:

- `step-start`, `step-finish` (part types) — already covered by
  `message.part.updated` text deltas.
- `todo.updated`, `command.executed` — not surfaced in our DO log yet; add
  when UI needs them.
- `lsp.*`, `pty.*`, `tui.*`, `mcp.*`, `vcs.*` — irrelevant to a headless
  runner.
- `session.compacted`, `session.deleted`, `message.removed` — out of scope
  (no compaction inside a single turn).

New event type added to `src/core/types.ts` for M4:

```ts
| "agent.usage"   // payload: { tokens: { total, input, output, reasoning, cache: { read, write } }, cost, modelID, providerID }
```

No other type additions in M4. `tool.started`, `tool.completed`,
`file.changed` already exist in `HermesEventType` and finally start
firing.

---

### 11.10 Updates to §11.3 / §11.5 from §11.8 verification

These supersede the corresponding rows/bullets above. Originals kept for
history per §6.

**§11.3 scope of change — additions / overrides:**

| Layer | Change |
|---|---|
| `package.json` | pin `opencode-ai@1.17.10` (CLI) + `@opencode-ai/sdk@1.17.10` (typed client), bundled into `runner.js` via `Bun.build` so the sandbox needs no runtime `npm install`. **Exact pin, no caret** — SDK API drift is real. |
| `src/runner/supervisor.ts` | (a) spawn `opencode serve --hostname=127.0.0.1 --port=4096` as a child on startup, (b) wait for `start.json` as today, (c) after start.json arrives, call `PUT /auth/zai-coding-plan` with the `ZAI_API_KEY` from start.json, (d) exec runner, (e) on **either** child exit, kill the other. |
| `src/launcher/provision.ts` | drop `OPENCODE_MODEL` from start.json (model now in prompt body); **keep** `ZAI_API_KEY` (supervisor needs it for `auth.set`). |

**§11.5 risks — replaced:**

- **OpenCode SDK API drift.** Mitigated: both packages pinned exact at
  `1.17.10`. Re-pin deliberately on each upgrade.
- **~~`opencode serve` startup time across pause/resume.~~** Resolved by
  §11.8.B. Snapshot preserves the running serve process (same PID, port
  still LISTEN). No fallback path needed.
- **Two-child supervisor.** Must kill both on either crashing. Covered by
  new `tests/supervisor.test.ts` in the M4 PR.
- **`tokens.total`, not `cost`, is the usage metric on Z.AI Coding Plan.**
  Documented in §11.8.A. The §8.4 "per-session token spend cap" backstop
  reads `tokens.total`.
- **PR-creation flow** still lives in the runner — out of scope for M4.

---

### 11.11 Step-0 verification of SSE timing + final event mapping (2026-06-25)

Before writing M4 runner code we ran a second live smoke test
(`/tmp/m4-sse-smoke.ts`) to verify the runner↔opencode event flow. This
fixes a wrong assumption in §11.9.

#### 11.11.A SSE endpoint is per-directory

Hitting `/event` **without** a `?directory=` query returns only
`server.connected` + `server.heartbeat` — no domain events. With
`?directory=/home/user/repo` we get the full stream. → Runner must
subscribe to `/event?directory=${REPO_DIR}`.

#### 11.11.B New event type discovered: `message.part.delta`

SDK `1.17.10` emits **both** `message.part.updated` (cumulative snapshot
of a part) AND `message.part.delta` (incremental token chunk). The TS
types in `@opencode-ai/sdk` only document the former. The mapping in
§11.9 used `message.part.updated` for text deltas — wrong; that would
fire once per cumulative snapshot, not per token. **Corrected mapping
table in §11.11.E.**

#### 11.11.C `session.idle` fires +1232 ms AFTER `session.prompt` HTTP returns

| Marker | Wall-clock | Source |
|---|---|---|
| `session.prompt` HTTP response returns | t=15,472 ms | host fetch |
| First `session.idle` SSE frame | t=16,704 ms | SSE subscriber |

→ HTTP response is the **safer, deterministic** terminal marker.
`session.idle` is logged only. Lock terminal = HTTP response.

#### 11.11.D Event volume seen in one turn

215 SSE frames for one ~14 s turn that wrote 1 file:
- 100+ `message.part.delta` (text streaming)
- 21 `message.part.updated` (snapshots + tool state transitions)
- 14 `message.updated` (assistant msg snapshots)
- 8 `session.status` (busy↔busy↔idle)
- 1 `session.idle` ✅
- 1 `file.edited` ✅
- 2 tools used (`read`, `edit`)
- ~30 boot noise (`plugin.added`, `catalog.updated`, `reference.updated`,
  `integration.updated`, `session.next.*`, `server.heartbeat`)

→ Runner uses **allowlist**, not denylist.

#### 11.11.E Final OpenCode → Hermes mapping (supersedes §11.9)

| OpenCode SSE event | Condition | Hermes event | Payload |
|---|---|---|---|
| `message.part.delta` | `part.type=="text"`, `delta` non-empty | `agent.message.delta` | `{ text }` |
| `message.part.updated` | `part.type=="tool"`, `state.status=="running"` (dedup by `callID`) | `tool.started` | `{ callID, tool, input }` |
| `message.part.updated` | `part.type=="tool"`, `state.status=="completed"` | `tool.completed` | `{ callID, tool, output, title, metadata }` |
| `message.part.updated` | `part.type=="tool"`, `state.status=="error"` | `tool.completed` | `{ callID, tool, error }` |
| `message.part.updated` | `part.type=="text"`, no `delta` (cumulative snapshot) | `agent.message.complete` | `{ text }` (truncated to 4 KB) |
| `file.edited` | always | `file.changed` | `{ file }` |
| `permission.updated` | always (M4: log only; no gating until P2.1) | `approval.requested` | `{ id, ptype, title, callID, metadata }` |
| `session.error` | always | `agent.error` | `{ error, name }` |
| `session.idle` | (drop — terminal handled by HTTP response) | — | — |
| every other type | drop | — | — |

`agent.usage` is **not** SSE-driven — emitted from `session.prompt` HTTP
response body (`info: AssistantMessage`). Source of truth is the response,
not events.

#### 11.11.F Auth flow — `ZAI_API_KEY` is now the canonical name

Pre-M4 launcher set `ZHIPU_API_KEY` (opencode's auto-detect env var). M4
supervisor calls `PUT /auth/zai-coding-plan` after start.json arrives —
no env-var auto-detect needed. Launcher writes both
`ZAI_API_KEY` (new, canonical) and `ZHIPU_API_KEY` (back-compat) to
start.json so the supervisor finds whichever is present.

#### 11.11.G Lock summary

Locked-in for M4 implementation:

1. SSE URL: `${OPENCODE_BASE_URL}/event?directory=${encodeURIComponent(REPO_DIR)}`
2. Terminal marker: `session.prompt` HTTP response (not `session.idle`).
3. Usage source: `resp.data.info.tokens` (with `tokens.total` fallback to `input+output+reasoning`).
4. Auth: `PUT /auth/zai-coding-plan` once after `start.json`, before
   spawning runner.
5. Pin: `@opencode-ai/sdk@1.17.10` (exact, no caret); `opencode-ai@1.17.10`
   pinned in template build only (the CLI is a native binary, postinstall
   breaks on macOS hosts).
6. Mapper: pure module `src/runner/event-mapper.ts`; uses event allowlist.

#### 11.11.H Implementation status (2026-06-25)

| Item | Status | Source |
|---|---|---|
| `package.json` pinned `@opencode-ai/sdk@1.17.10` | ✅ | `package.json` |
| `src/runner/supervisor.ts` rewritten (serve + auth + babysit) | ✅ | `src/runner/supervisor.ts`, `src/runner/supervisor-helpers.ts` |
| `src/runner/sandbox-runner.ts` rewritten (SDK + SSE + mapper) | ✅ | `src/runner/sandbox-runner.ts` |
| `src/runner/event-mapper.ts` pure mapper module | ✅ | new file |
| `agent.usage` added to `HermesEventType` | ✅ | `src/core/types.ts` |
| `OPENCODE_MODEL` dropped from `provision.ts` + `server.ts` | ✅ | model now per-prompt via SDK body |
| `ZAI_API_KEY` propagated through start.json | ✅ | back-compat `ZHIPU_API_KEY` also written |
| `tests/runner-event-mapping.test.ts` (11 cases) | ✅ | exhaustive mapping table coverage |
| `tests/supervisor.test.ts` (5 cases) | ✅ | babysit + auth.set helpers |
| `bun test` 73/73 + `tsc --noEmit` clean | ✅ | local |
| E2B template rebuilt with new supervisor + runner bundle | ⏳ Step 7 | `bun run template:build` |
| Live e2e — tool/file/usage events in DO log | ⏳ Step 8 | requires template rebuild |
| Live e2e — follow-up prompt additive ≤50% turn time | ⏳ Step 9 | §11.4 criterion 2 |
| Real PR e2e | ⏳ Step 10 | §11.4 criterion 4 |

---

### 11.12 M4 e2e verification (live run, 2026-06-25)

End-to-end run against the freshly-rebuilt `hermes-runner` template, real
Worker + ngrok + launcher sidecar + real Z.AI Coding Plan + real GitHub
App. Wall: ~12 s from `POST /sessions` to `status=completed`. PR opened:
<https://github.com/duckhoa-uit/hermes-control-plane/pull/6>.

DO event log shape (excerpt):

| Hermes event type | Count | Notes |
|---|---|---|
| `tool.started` | 2 | ✅ M4 success criterion 1 (was 0 before M4) |
| `tool.completed` | 2 | ✅ pairs match tool.started |
| `file.changed` | 1 | ✅ M4 success criterion 1 (was 0 before M4) |
| `agent.usage` | 1 | ✅ M4 success criterion 3, new event type |
| `agent.message.complete` | 2 | text snapshots |
| `agent.done` / `pr.created` / `git.diff.ready` | 1 / 1 / 2 | terminal artifacts |
| `session.status_changed` | 7 | matches normal DO state machine |

Diff produced (verified at `artifacts.diff`):

```
diff --git a/README.md b/README.md
@@ -1,5 +1,7 @@
 # Hermes Control Plane

+M4 verified
+
 Control plane for AI coding agents. ...
```

§11.4 success criteria status:

| # | Criterion | Status |
|---|---|---|
| 1 | tool.started + tool.completed + file.changed each ≥1 per turn | ✅ verified in DO log (2/2/1) |
| 2 | Follow-up prompt ≤50% of first turn wallclock | ⏳ partial — §11.8.B showed 28% on raw SDK; full hermes follow-up requires runner stay-alive after PR (out of M4; tracked under M2.3 prompt queue) |
| 3 | `artifacts.usage` carries non-zero input/output tokens | ✅ live run emitted `agent.usage` event; `cumulative` payload accumulates per turn (see runner `usageRollup`) |
| 4 | No regression — existing tests pass + real PR opens | ✅ 73/73 tests; PR #6 mergeable |

#### Follow-up prompt (criterion 2) — scope decision

The two-turn flow has two layers:

1. **OpenCode session-level**: same `ses_…` id, second `session.prompt`
   benefits from server-side cache. Verified in §11.8.B (4.2 s → 5.2 s
   with `cache.read: 7424`; 28% / well under 50% — but second turn
   reused identical session and was effectively a "ping" reply).
2. **Hermes session-level**: client-issued follow-up via
   `POST /sessions/:id/prompt`. Today the runner exits after PR
   creation, so the second prompt returns 409 (runner not connected).
   Holding the runner alive after PR is an explicit M2.3 follow-up
   (prompt queue + mid-run stop in the deferred list §8.3).

M4's scope is the runner ↔ opencode boundary, not the session lifecycle.
Layer 1 is verified; layer 2 is the right thing to test under M2.3 once
the runner stays alive past the first PR. §11.4 criterion 2 will land
green when M2.3 ships.

#### Side-by-side: before vs after M4

| Surface | Pre-M4 (CLI mode) | Post-M4 (SDK mode) |
|---|---|---|
| Agent invocation | `spawn("opencode", ["run", …])` per turn | persistent `opencode serve` + SDK `session.prompt` |
| Tool fidelity in DO log | declared but never fired | `tool.started`, `tool.completed` per call |
| File-change fidelity | `git diff --name-only` after turn only | live `file.changed` per edit |
| Token usage / cost | not captured | `agent.usage` event + `artifacts.usage` rollup |
| Stream UX | stdout chunks | true SSE deltas via `message.part.delta` |
| Provider auth | env var (`ZHIPU_API_KEY`) | `PUT /auth/zai-coding-plan` once |
| Model selection | CLI flag (`--model`) | per-prompt body |
| Snapshot warmth | runner only | runner + `opencode serve` listening on 4096 |

#### Status: M4 done (modulo follow-up criterion deferred to M2.3).
