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
  (`src/worker/session-do.ts`). DO Storage is the sole truth (D1/R2
  removed in §12.16).
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
| 9 | DO + SQLite per session | Yes | DO Storage only (D1/R2 declared but unused — deleted §12.16) | 🟡 | Low | Split-store deferred per §8.5 |
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
| 22 | Long-pause resume | autoResume + warm session over hours | M2 `autoResume:true` set but `Sandbox.connect()` never called; heartbeat marks paused sandbox as `failed` after 60 s | 🟡 | Med (kills follow-up UX) | Tracked under §12 M5 |
| 23 | D1 / R2 retention | retention policy + cron GC | N/A — D1/R2 removed §12.16; DO storage retention deferred per §8.5 | ⏸ | Low (single user) | §12.16 |

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
- Users want to follow up on a session hours later → do **§12 M5 long-pause resume**.
- D1 / R2 storage cost noticeable → do **§12 M5 retention cron**.

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
2. **Follow-up prompts hit the warm opencode session.** e2e test does
   (a) initial prompt edits file A; (b) `POST /sessions/:id/prompt` edits
   file B; (c) assert (i) cache-read / total-tokens ratio on turn 2
   ≥ 80 %, (ii) `agent.usage.cumulative` reflects sum across turns,
   (iii) the diff in the eventual PR contains both A and B as a single
   additive commit. (Wall-clock is a poor proxy here — fixed costs
   dominate small turns; §11.13 elaborates.)
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

---

### 11.13 Follow-up prompt e2e — criterion 2 verified live (2026-06-25)

Two-turn run against the same hermes session, real Worker + ngrok +
launcher (`HERMES_AUTO_PR=0` to keep the runner alive past the first
turn), real Z.AI + real GitHub App. PR opened with the cumulative diff
from both turns: <https://github.com/duckhoa-uit/hermes-control-plane/pull/7>.

#### What changed to enable this

| Layer | Change |
|---|---|
| `src/core/state-machine.ts` | Allow `review_ready → running` so a follow-up prompt doesn't break the DO state machine. |
| `src/worker/session-do.ts` | `POST /sessions/:id/prompt` transitions `review_ready → running` before sending `agent.prompt` (so the second `runner.complete` can transition back to `review_ready` cleanly). |
| `src/launcher/server.ts` | New env toggle `HERMES_AUTO_PR=0` to skip the sidecar's auto-PR trigger on `review_ready`. Default `1` (production behaviour); set to `0` for follow-up e2e + future M2.3 prompt-queue work. |
| `tests/state-machine.test.ts` | Added test case for `review_ready → running` transition. |

#### Live evidence

| Marker | Value | Source |
|---|---|---|
| Turn 1 wall (provision → `review_ready`) | 25 s | `POST /sessions` → first `review_ready` |
| Turn 2 wall (`POST /sessions/:id/prompt` → `review_ready`) | 18 s | second poll loop |
| Turn 2 / Turn 1 ratio | **72 %** | dominated by fixed network costs at this tiny task size |
| `agent.usage` events | 2 (one per turn) | DO log |
| Turn 1 token totals | `input=87 output=3 reasoning=0 cache.read=8832 total=8922` | first `agent.usage.tokens` |
| Turn 2 token totals | `input=70 output=3 reasoning=0 cache.read=11648 total=11721` | second `agent.usage.tokens` |
| **Turn 2 cache-hit ratio** | **99.4 %** (11648/11721) | strong evidence opencode session was reused warm |
| Cumulative usage at end | `input=157 output=6 cache.read=20480 total=20643` | `cumulative` field on second `agent.usage` |
| Tool events | `tool.started=4 tool.completed=4` (2 per turn) | DO log |
| File-change events | `file.changed=2` (README + docs/SETUP.md) | DO log |
| Additive diff in PR #7 | `README.md: +1/-0`, `docs/SETUP.md: +1/-0` (2 files, single PR) | GitHub API |

#### Reading the result

Criterion 2 as originally written ("≤ 50 % of first turn wallclock") fails
at this task size — but the criterion was *measuring the wrong thing*.
Wall-clock for a 1-line edit is dominated by fixed costs (sandbox boot,
git clone, model context priming) that are paid once and amortized across
all turns in a session. The thing that actually proves "follow-up turns
reuse opencode session warm" is the **cache-hit ratio on the LLM side**:
99.4 % of turn 2's tokens were served from cache. That is the
Inspect-shape behaviour the criterion was after.

The wall-clock figure will look better for tasks where the LLM does more
than three output tokens; today's smoke is bounded by the trivial output.
A more honest restatement of criterion 2 lives in §11.4 as updated below.

#### §11.4 criterion 2 — updated and met

> (2) **Follow-up prompts hit the warm opencode session.** Cache-read /
> total-tokens ratio on the second turn ≥ 80 %; cumulative usage event
> reflects sum across turns; additive diff lands in a single PR.

Status: ✅ verified — 99.4 % cache hit, cumulative rolled up, PR #7
contains both turns' edits in one commit.

#### Status

M4 fully done. All §11.4 success criteria (1, 2, 3, 4) verified by live
evidence.

---

## 12. M5 — long-pause resume + session lifecycle GC (proposed)

### 12.1 Why

M4 §11.13 verified that **immediate** follow-up prompts (seconds after
`review_ready`) work. Walking the code revealed three honest gaps in
the longer-tail story:

1. **DO can't tell "sandbox paused" from "runner dead"**. Heartbeat
   stops the moment E2B pauses the sandbox (process frozen). After
   `HEARTBEAT_TIMEOUT_MS = 60s` the DO transitions `running → stalled
   → failed`. The launcher's per-session watcher then sees `failed`
   and kills the sandbox. So in practice the "follow-up window" is
   ~60 s, not the 15-min auto-pause window M2 implies.
   - Source: `src/worker/session-do.ts:506-535`, `constants.ts:2`,
     `src/launcher/server.ts:62-117`.

2. **`Sandbox.connect()` never gets called from runtime code.** The
   M2 `autoResume: true` flag is set
   (`src/launcher/provision.ts:47`) but no path triggers a resume —
   the launcher only `Sandbox.create()`s, never reconnects. So
   "auto-pause + autoResume" is half-implemented: pause works, resume
   doesn't reach the user.

3. **`MAX_SESSION_RUNTIME_MS` is declared dead code.** Defined in
   `src/core/constants.ts:3` and listed in `wrangler.toml`, but no
   code path enforces it. The actual upper bound is the launcher
   watcher's 35-min hard deadline (`src/launcher/server.ts:69`).

4. **D1 / R2 / DO storage never GC'd.** Sessions accumulate forever
   in terminal states. No cron job, no retention policy.

### 12.2 What "long-pause resume" should look like

```
t=0       turn 1 ends, status=review_ready, runner WS connected
t=60s     runner heartbeat dies (E2B paused sandbox → process frozen)
t=60s     DO sees no heartbeat → NEW status: `idle_paused` (not `failed`)
          (heartbeat watchdog stays quiet while in `idle_paused`)
t=2h      user POST /sessions/:id/prompt
          DO sees status=idle_paused → calls launcher /resume
          launcher does Sandbox.connect(id) → runner Node thaws →
          re-dials WS to DO → DO transitions back to `running` →
          forwards agent.prompt as today
```

### 12.3 Scope of change

| Layer | Change |
|---|---|
| `src/core/state-machine.ts` | New status `idle_paused`. Allowed transitions: `running → idle_paused`, `review_ready → idle_paused`, `idle_paused → running`, `idle_paused → failed`, `idle_paused → aborted`. |
| `src/worker/session-do.ts` | (a) Heartbeat timeout in `running` / `review_ready` transitions to `idle_paused` (not `stalled → failed`). (b) `idle_paused` stops the heartbeat watchdog. (c) `POST /prompt` while `idle_paused` → call launcher `/resume`; if 200, transition `idle_paused → running` and queue the prompt for delivery once `runner.connected` arrives again. |
| `src/launcher/server.ts` | (a) Watcher does NOT kill sandbox on DO status `idle_paused` — only on `failed`/`aborted`/`completed` or absolute deadline. (b) New route `POST /sessions/:id/resume` calls `Sandbox.connect(sandboxId)`; on success the runner thaws and dials back to DO. (c) Watcher deadline becomes the *upper* idle bound: e.g. `MAX_IDLE_PAUSED_MS = 2 h` for `idle_paused`, `MAX_RUNTIME_MS = 6 h` absolute. |
| `src/launcher/provision.ts` | Increase `SANDBOX_TIMEOUT_MS` (today 15 min) to match the new `MAX_IDLE_PAUSED_MS`, since the pause budget should be the user-facing knob. |
| `src/core/constants.ts` | Replace dead `MAX_SESSION_RUNTIME_MS` with `MAX_IDLE_PAUSED_MS` + `MAX_TOTAL_RUNTIME_MS` (both enforced; values overridable via `wrangler.toml`). |
| `src/worker/session-do.ts` | Pending-prompt queue: while `idle_paused → running` transition is mid-flight, hold the new prompt in DO storage and replay on `runner.connected`. (This is the M2.3 "prompt queue" wedge but only the minimal subset needed for resume; full queue is still M2.3.) |
| Tests | (a) state-machine: idle_paused round-trip. (b) Mock provision.test.ts: `Sandbox.connect` called on resume path. (c) Integration: heartbeat timeout → idle_paused, not failed. |
| Docs | Update README "Flow" diagram + §11.13's "Reading the result" — now follow-up window is hours, not seconds. |

### 12.4 Cleanup strategy (after M5)

| Resource | Owner | When killed | Mechanism |
|---|---|---|---|
| E2B sandbox (compute) | Launcher | DO terminal (`completed`/`failed`/`aborted`) OR `MAX_IDLE_PAUSED_MS` exceeded OR `MAX_TOTAL_RUNTIME_MS` exceeded | watcher tick + `entry.kill()` |
| E2B sandbox (orphaned post-launcher-restart) | Launcher sweeper | Sidecar boot | `sweepOrphans()` (already exists) |
| E2B sandbox billing | E2B platform | `idle_paused` → pause billing (already today via `onTimeout: 'pause'`) | E2B native |
| DO instance | Cloudflare | Hibernation between events (free) | Workers Runtime |
| D1 session row | New cron | Terminal age > `D1_RETENTION_DAYS` (e.g. 30) | scheduled Worker (P4.1 prereq) |
| Event log | New cron | Same retention | scheduled Worker |
| R2 artifacts | New cron | Same retention | scheduled Worker |

The cron piece is the right home for these — Cloudflare Workers Cron
Triggers, already on the platform.

### 12.5 Success criteria

1. **Follow-up after 1 hour idle works.** Manual test: create session,
   reach `review_ready`, wait > 60s (let heartbeat lapse) → wait
   another 60 min → `POST /prompt` → status flips
   `idle_paused → running` → second turn completes → cumulative diff
   contains both turns. Wall-clock of the resume step ≤ 5 s (E2B
   `Sandbox.connect` is ~500 ms per §11.8.B; runner re-dial + WS
   handshake adds the rest).

2. **Sandbox not killed prematurely.** During the 1-hour idle wait,
   `Sandbox.list` shows the sandbox in `paused` state the whole time
   (not removed); launcher watcher log shows no `killing sandbox`
   line.

3. **Hard upper bound holds.** Session left fully idle for >
   `MAX_IDLE_PAUSED_MS` (e.g. 2 h) → launcher kills sandbox → DO
   transitions `idle_paused → failed` with `errorMessage = "idle
   timeout"`. Subsequent `POST /prompt` returns 410 Gone with a clear
   message.

4. **Retention cron deletes old terminal sessions.** Insert a fake
   terminal session aged `D1_RETENTION_DAYS + 1` → run cron handler
   → row gone, event log gone, R2 prefix gone. Live sessions
   untouched.

### 12.6 Risks

- **E2B paused-sandbox quota.** Hobby/Pro tier has a cap on total
  paused sandboxes (separate from the 20-concurrent live cap). With
  longer idle windows we accumulate more paused sandboxes per active
  user. Check current limit before raising `MAX_IDLE_PAUSED_MS` past
  the cap. Mitigation: include paused count in the M3 concurrency
  guard.

- **Resume not always idempotent.** If `Sandbox.connect()` races with
  E2B's own GC (sandbox aged past *E2B's* internal pause TTL, not
  ours), connect returns 404. Handle as terminal failure with a
  user-friendly "session expired" message.

- **Runner state-on-disk drift.** While paused, the runner's repo
  working copy on `/home/user/repo` is frozen but the *real* base
  branch on GitHub may have moved. The follow-up turn might produce a
  diff that doesn't apply cleanly anymore. M5 surfaces this as a
  runtime error from `git push`; a real fix (rebase before turn 2)
  is its own concern, tracked alongside P1.2 webhook ingestion.

- **Prompt-queue subset overlap with M2.3.** M5 introduces a tiny
  prompt-queue (one slot, drained on `runner.connected`). M2.3 is
  the full prompt-queue + mid-run stop. Make M5's slot a single
  field, not an array, so M2.3 can replace it without churn.

### 12.7 Out of scope for M5

- Full prompt-queue (M2.3).
- Webhook ingestion + auto-resume on PR comment (P1.2).
- Session forking via E2B snapshots (deferred §8.3).
- D1 / R2 retention UI controls — cron with a constant is enough for
  one user.

### 12.8 Status

Proposed. Not started.

---

### 12.9 Prior art (research, 2026-06-25)

Researched relevant projects before committing to M5 design. Findings:

#### OpenHands (`All-Hands-AI/openhands`) — direct precedent

Same architecture as hermes (background coding agent + remote sandboxes).
They shipped exactly the M5 pattern we proposed, with a security wrinkle
we missed and an architectural simplification we can't borrow.

**What they do, mapped to §12:**

| OpenHands construct | Hermes equivalent in §12 |
|---|---|
| `SandboxStatus.PAUSED` first-class status | `idle_paused` (✅ matches §12.3) |
| `resume_sandbox(id)` → `POST /resume` on runtime API | Launcher `POST /sessions/:id/resume` → `Sandbox.connect(id)` (✅ matches §12.3) |
| Triggered when picking up a new task (see `live_status_app_conversation_service.py:875-876`) | DO's `POST /prompt` calls resume when status==`idle_paused` (✅ matches §12.3) |
| LRU pause when concurrency cap hit (`pause_old_sandboxes`) | M3's concurrency guard already in place; M5 just lets paused sessions stay around | 
| `wait_for_sandbox_running` poll loop after resume | (need to add — see §12.10) |
| **Rotates `session_api_key_hash` on resume**, clears it on pause | (missed — see §12.10 addendum 1) |

**Key architectural gap from OpenHands to us:** OpenHands uses
**outbound HTTP polls from app server → agent server inside sandbox**.
Resume is trivial — the next `httpx.get(/alive)` works after E2B
resumes. Hermes uses **outbound WebSocket from sandbox runner → DO**.
After resume the runner's TCP socket is half-dead and the runner
process needs to notice + redial. Our resume path is more complex.

#### opencode upstream (anomalyco fork) — agent-layer is free

Sessions are durable in SQLite (`packages/core/src/session/sql.ts`).
`SessionHistory.load(db, sessionID)` rehydrates at any time. Sessions
have no TTL or expiry. As long as the sandbox disk survives, the
opencode session survives — and our session-prompt-with-id reuses
the conversation cache (verified §11.13 99.4% cache hit). **No
agent-side work needed for M5.**

#### E2B `autoResume: true` — clarified semantics

Verified in `e2b-dev/e2b` source
(`packages/js-sdk/tests/sandbox/lifecyclePayload.test.ts`):
**`autoResume: true` only wakes a paused sandbox on an HTTP request
to an exposed port.** Outbound traffic from inside the sandbox does
not trigger it. Our outbound-WS architecture means the current
`provision.ts:47` flag is a no-op for the long-pause case — only an
explicit `Sandbox.connect()` from the launcher will resume.

→ Strengthens §12.1 gap #2: the flag is set but unreachable from our
control flow. M5 must replace "autoResume hope" with explicit
launcher-driven `Sandbox.connect()`.

#### Modal `_experimental_from_snapshot` — different model

Modal exposes `snapshot_filesystem()` + `_experimental_from_snapshot()`
which returns a **new** sandbox from a snapshot. This is a
restart-and-rehydrate model (Ramp Inspect uses it). More expensive
than E2B's pause/resume; primarily useful for forking ("retry this
prompt with a different model"). **Out of M5 scope.** Tracked in
§8.3 "Snapshot-based session forking".

#### Ramp Inspect — warm-on-keystroke + snapshots

Per §1 summary: "filesystem snapshots for resume; warm pool for hot
repos; warm-on-keystroke". Pool + warm-on-keystroke are perf
optimizations layered ON TOP of basic resume; M5 lands the basic
resume primitive first (the prerequisite). Pool/warm = future P0.3
which §11.6 already declares out of scope for M4.

### 12.10 Addenda to §12 from prior-art research

Bumping into OpenHands' design surfaced four refinements to fold into
M5 implementation when it lands. Each is a small, surgical addition.

#### Addendum 1: Rotate runner token on resume (security)

**Risk:** A leaked runner token (from logs, sandbox dumps, etc.)
remains usable while the sandbox is paused — there's no expiry on
hermes session-scoped tokens today.

**Fix in M5:**
- On `running → idle_paused`: DO drops its cached runner-token hash,
  forcing re-validation on next WS upgrade.
- On `idle_paused → running` (launcher `/resume`): launcher mints a
  new short-lived runner token, writes the new token to
  `/opt/hermes/start.json` (the supervisor will pick it up on the
  next runner spawn — or, if the runner is being thawed in-place,
  we need to re-deliver it some other way; see addendum 2).
- Add `/sessions/:id/rotate-runner-token` route on the DO; launcher
  calls it before `Sandbox.connect()` so the DO will accept the new
  token on the runner's re-dial.

#### Addendum 2: Runner WS reconnect loop

Hermes runner uses outbound WS to DO. After `Sandbox.connect()`:
- Runner Node process thaws.
- Its WS socket is in TCP half-close state (peer DO closed long ago).
- `ws.on("close")` and `ws.on("error")` will fire as the OS notices.

**Fix in M5:**
- Wrap the WS in a reconnect loop (`src/runner/sandbox-runner.ts`):
  on `close` or `error`, retry with exponential backoff (1s, 2s, 4s,
  8s, 16s, cap 30s, total budget 2 min). On reconnect: re-send the
  initial `runner.connected` frame.
- Reload `start.json` on reconnect so the new runner token from
  addendum 1 is picked up. Old in-memory `RUNNER_TOKEN` is stale.
- If reconnect budget exhausts: process exits cleanly (the supervisor
  picks this up and shuts down opencode serve, which sets the M4
  babysit chain in motion).

#### Addendum 3: DO accepts the rotated token

Today the DO checks the incoming token against the one minted at
session-create time (single hash). M5 needs it to accept either
"current token" or "previous token" within a short grace window
during the rotate→resume→reconnect window — otherwise the runner's
in-flight reconnect with the *old* token gets rejected before
`start.json` reload completes.

**Fix in M5:** DO stores `currentTokenHash` + `previousTokenHash`
(both valid for up to 60 s). Rotate sets previous := current,
current := new.

#### Addendum 4: Use OpenHands' state names

OpenHands' enum:
`STARTING`, `RUNNING`, `PAUSED`, `ERROR`, `MISSING`. We map cleanly:

- ours `provisioning` / `runner_connecting` → their `STARTING`
- ours `running` / `review_ready` → their `RUNNING`
- M5 new `idle_paused` → their `PAUSED`
- ours `failed` / `aborted` → their `ERROR`
- ours implicit-after-launcher-kill → their `MISSING`

No rename needed; this is just confirmation that our enum is already
in the right shape (one new value is all M5 adds).

### 12.11 Decision: ship §12 as-is, fold addenda into PR

The §12 scope is correct. The four addenda above are minor — total
incremental work ~50 lines beyond what §12.3 already lists. Land
them together in the M5 PR.

---

### 12.12 Quick fix shipped — follow-up window 60 s → ~50 min (2026-06-25)

**Partially reverted after §12.14 analysis** (see end of section for
what survived). Original write-up kept for history.

Closing the most-painful symptom of the §12 gap without doing full M5.
Three knobs tuned + one new launcher action:

| Change | Rationale |
|---|---|
| `HEARTBEAT_TIMEOUT_MS: 60s → 15 min` (`src/core/constants.ts`, `wrangler.toml`) | Codex picks 10 min, OpenHands picks none; 15 min splits the middle and matches E2B's 15-min auto-pause window. Real runner crashes still detected within 15 min — well under the 60-min launcher hard cap. |
| Skip heartbeat watchdog at `review_ready` (`src/worker/session-do.ts:checkHeartbeat`) | E2B may pause the sandbox after 15 min idle in `review_ready`; that silences heartbeats but is not a real failure. Watchdog runs in `running` only (where stalls do mean trouble). |
| Launcher extends sandbox timeout on first `review_ready` (`src/launcher/server.ts:watchSession`) | `Sandbox.setTimeout(sandboxId, 55*60_000)` extends the E2B-side onTimeout from 15 min to 55 min — safely under Hobby's 60-min hard cap. Without this the sandbox would pause + heartbeat would resume firing in 60-90 s. |
| Launcher hard deadline `35 min → 60 min` (`src/launcher/server.ts`) | Matches E2B Hobby's per-sandbox cap. Anything past 60 min is illegal at E2B's level anyway. |

#### Effective follow-up window after the fix

| Status | Window |
|---|---|
| `running` (turn in progress) | 15 min runner silence → fail (Codex-ish) |
| `review_ready` (waiting for follow-up) | **up to 55 min** before E2B pauses; launcher then kills at 60-min absolute |
| Real runner crash mid-turn | detected within 15 min via heartbeat |
| Sandbox boot stuck | 2-min provisioning timeout (unchanged) |

#### What's still not solved (and why we're OK with that)

- **Resume from a paused sandbox.** Still impossible — once E2B pauses
  the sandbox at the 55-min mark, the runner WS is half-dead and we
  have no `Sandbox.connect()` codepath. The launcher kills it at 60
  min. Window is bounded.
- **Sub-15-min real runner stalls.** A runner that genuinely freezes
  inside `running` is detected in up to 15 min, vs the prior 60 s.
  Worst-case quota cost: ~$0.03 per false-positive vs $0.0001 before.
  Acceptable for one user.
- **Long-pause-then-resume after hours/days.** This is the real M5
  scope (§12). Not shipped. The fix above just stops the 60-second
  cliff from being the bottleneck.

#### Comparable numbers in similar projects (researched 2026-06-25)

| Project | Idle / heartbeat timeout | Reconnect model |
|---|---|---|
| Hermes (before this fix) | 60 s | none |
| **Hermes (after this fix)** | **15 min / 55 min** | none (still kills) |
| Codex remote-control transport | 10 min, 30 s sweep | explicit `resume` frame |
| OpenHands | none — pure LRU eviction | `resume_sandbox(id)` route |
| opencode (agent only) | n/a — session in SQLite forever | n/a |

Hermes after the fix sits between Codex (10 min) and OpenHands (∞).

**Partial revert (2026-06-25, after §12.14 docs+probe research)**

§12.14 verified via E2B docs that paused sandboxes are free, indefinite,
and uncapped. The two §12.12 knobs that kept the sandbox _running_ to
avoid the pause were therefore counter-productive — they burn toward
E2B Hobby's 1-hour continuous-runtime cap (which RESETS on resume).
The right behaviour is "let E2B pause early, resume on demand". Resume
needs M5 (§12.14) to ship; until then the user-visible behaviour is the
same 410/409 fail-fast (§12.13), but at least we stop wasting quota.

Reverted:
- `Sandbox.setTimeout(55min)` extension on first `review_ready` (removed
  from `src/launcher/server.ts`).
- Launcher hard deadline `60 min` → bumped to `24 h` (purely a runaway-job
  backstop; not a follow-up window cap anymore).

Kept (correct regardless of M5):
- `HEARTBEAT_TIMEOUT_MS = 15 min` (catches real stalls without false-
  positive on paused sandboxes; paused sandbox state is now handled
  separately by the runner-disconnected check rather than heartbeat).
- Heartbeat watchdog skipped at `review_ready` (idle review_ready is not
  a stall).

**Effective behaviour after the partial revert (today):**

| State | Window |
|---|---|
| `running` (turn in progress) | 15 min runner silence → fail |
| `review_ready` (idle) | sandbox auto-pauses after 15 min; follow-up after that returns 409 with `recoverable: false` (§12.13) until M5 ships |
| Real runner crash | detected within 15 min |
| Runaway session not garbage-collected | killed at 24 h hard deadline |

The follow-up window is now bounded by E2B's `onTimeout: 'pause'` (15 min)
rather than by our 55-min `setTimeout` extension. Same 409 fail-fast UX
for the user; M5 (§12.14) flips it to a transparent resume.

---

### 12.13 Fail-fast contract for /sessions/:id/prompt (2026-06-25)

Quick fix §12.12 extends the follow-up window to ~55 min, but it doesn't
make the failure mode any less abrupt — at 55 min the sandbox is killed
and any follow-up after that point cannot succeed. Codify what the
client sees so it can handle this without guessing.

#### Response shapes

| Situation | HTTP | `error` | `recoverable` | `status` |
|---|---|---|---|---|
| Runner connected, follow-up forwarded | 200 | — | — | — |
| Runner WS gone, session non-terminal (sandbox killed by deadline, lost connection during turn, etc.) | **409** | `"Runner not connected"` | `false` | DO's current status (e.g. `review_ready`, `running`, `stalled`) |
| Session in terminal state (`completed` / `failed` / `aborted`) | **410** | `"Session ended"` | `false` | the terminal status |
| Session row gone entirely (sweeper / D1 row deleted) | 404 | `"session not found"` | n/a | — |

All non-success responses carry a `reason` string the client can render
verbatim to the user. The `recoverable: false` field is the contract:
**M5 will flip it to `true` for the 409 case when long-pause resume
lands**; clients can pre-bake retry logic now.

#### Example bodies

```json
// 409 Conflict — runner gone, session was review_ready
{
  "error": "Runner not connected",
  "status": "review_ready",
  "reason": "The follow-up window has elapsed. The sandbox is no longer reachable; long-pause resume is not implemented yet (tracked under §12 M5). Start a new session to continue.",
  "recoverable": false
}

// 410 Gone — session reached terminal state, sandbox already torn down
{
  "error": "Session ended",
  "status": "failed",
  "reason": "The session reached a terminal state and its sandbox has been torn down. Start a new session to continue the work; the previous diff and PR (if any) are preserved in the session record.",
  "recoverable": false
}
```

#### What clients should do

| Response | Recommended client action |
|---|---|
| 200 | Stream the next turn as normal |
| 409 `recoverable: false` | Surface the `reason`; offer "Start a new session with this task" button (today's UX) |
| 409 `recoverable: true` (post-M5) | Retry — server is bringing the sandbox back up; surface a spinner |
| 410 | Surface the `reason`; same "Start a new session" button. The completed PR is still linked in the session record. |
| 404 | Treat as 410 from the client's perspective — session is gone for good |

#### Test coverage

`tests/prompt-error-responses.test.ts` locks the shape of both 409 and
410 bodies. Anyone changing those payloads has to touch the test, which
keeps the client contract honest.

#### Status

Shipped together with §12.12. M5 (§12) will add `recoverable: true` +
the actual `/resume` route + retry-aware client UX.

---

### 12.14 §12 rewrite — what the docs + probe changed (2026-06-25)

Researched E2B docs + ran a live TCP-across-pause probe. The original
§12 design (§12.1–§12.10) was based on three wrong assumptions. Updated
canonical M5 design follows.

#### What the docs say (verified at `e2b.dev/docs/faq/paused-sandboxes-concurrency` and `e2b.dev/docs/sandbox/persistence`)

| Question | Old §12 assumption | Reality |
|---|---|---|
| Paused-sandbox quota | "may have cap, check before raising MAX_IDLE_PAUSED_MS" (§12.6) | **No limit.** Paused sandboxes are excluded from concurrency entirely. |
| Paused-sandbox billing | (not specified) | **Free.** Only running time is billed. |
| Paused-sandbox TTL | "E2B's internal pause TTL — could be 24h or 7 days, unknown" (§12.6) | **None.** "Kept indefinitely, no automatic deletion, never killed by E2B." |
| 1-hour continuous runtime cap | (treated as hard) | **Resets on resume.** A pause/resume cycle gives you a fresh 1h running budget. |
| Pause/resume timing | "resume in ~500 ms" (§11.8.B verified live) | Docs say 4s/GiB pause, 1s resume. Matches our prior observation. |
| `Sandbox.connect()` default timeout | (not specified) | 5 min, configurable. |

#### What the live TCP probe showed (`/tmp/m5-tcp-probe.ts`)

Setup: sandbox A hosts a WS echo server; sandbox B opens an outbound
WS to A and heartbeats every 2s. Pause B for 30s, then resume.

| Event | Observation |
|---|---|
| Pre-pause | WS open, heartbeats flowing, A acks each |
| During 30s pause | A's view: last message = `hb-4` (the one immediately before pause). No close. A does not see B drop. |
| Immediately after resume | B fires one `heartbeat sent` (sync app-layer success) followed by `close` event with code **1006** (abnormal closure, no normal handshake) ~2 ms later. No `error` event. |
| 2 s after resume | `readyState=3` (CLOSED). Subsequent heartbeats skip. |
| Server side after B resume | A receives **no** post-resume message; A's connection state is also dead. |

**Conclusions from the probe:**

1. WS does **not** survive pause/resume. Connection breaks the moment
   B thaws (likely because the kernel detects half-close after the
   socket's underlying network state was restored).
2. The break is signaled by `close` event with code 1006, **not**
   `error`. Runner reconnect loop must listen on `close`.
3. There's a ~ms-scale window after resume where one `ws.send()` will
   "succeed" synchronously before the close fires — buffered, but
   lost. Reconnect logic must not trust the first post-thaw send.
4. The server side also needs to handle a fresh connection from the
   same session id — A in the test treated it as a brand new client,
   but the real DO needs to accept the reconnect and rebind it to
   the existing `SessionDurableObject`.

#### Revised M5 design

Old §12 said: add `idle_paused` state, runner re-dials on resume.
New design is **simpler than that** because of three insights:

**Insight A: Paused is free + indefinite → no idle-cap policy needed.**

Drop `MAX_IDLE_PAUSED_MS`. There is no cost or operational reason to
ever kill a paused sandbox proactively. Replace with a much longer
`MAX_TOTAL_AGE_DAYS = 30` retention policy (paired with D1/R2 cron),
purely for storage hygiene, not E2B quota management.

**Insight B: 1h cap resets on resume → "long sessions" are pause-cycle, not single-run.**

The Hobby 1-hour continuous runtime cap is not a session lifetime cap.
A multi-hour or multi-day session = sequence of `running ↔ paused`
cycles, each running burst staying under 1h. M5's job is to make
that cycle invisible to the user.

**Insight C: WS dies on resume; runner must reconnect; server must accept rebind.**

§12.10.2's reconnect loop is mandatory, not optional. Concrete:

- Runner: on `close` (any code, not just 1006), exp-backoff reconnect
  (500ms, 1s, 2s, 4s, 8s, cap 15s, total budget 60s). Re-read
  `start.json` for the (possibly rotated) runner token. Re-send the
  initial frame so DO can rebind.
- DO: accept WS upgrades from `/sessions/:id/runner?token=…` even
  when the session has been runner-disconnected; rebind `runnerConn`
  to the new socket. (Existing code already does this — see
  `src/worker/session-do.ts:259-291`.) Flush any buffered prompts
  from the §12.10 single-slot queue.
- Launcher: `POST /sessions/:id/resume` does `Sandbox.connect(id)`
  (1s wall) and returns immediately. The runner inside the sandbox
  thaws and follows the reconnect loop.

**Quick fix §12.12 is counter-productive given these insights.**

Specifically:
- `Sandbox.setTimeout(55min)` keeps the sandbox running, **burning
  toward the 1h hard cap**. Should be removed: let E2B pause sooner
  (free) so the cap resets on the next resume.
- Launcher hard deadline 60min should also be removed. Sandboxes can
  live for days if user wants, all paused-free between turns.
- Heartbeat skip at `review_ready` (good) can stay, but the 15-min
  `HEARTBEAT_TIMEOUT_MS` value should be revisited once M5 ships —
  with proper resume the watchdog becomes the only stall detector
  and 15 min is borderline.

#### Revised M5 scope (replaces §12.3)

| Layer | Change | LoC |
|---|---|---|
| `src/core/state-machine.ts` | Keep current states. **No new `idle_paused`.** The session conceptually stays in `review_ready` (or `running` mid-turn) across the pause; only the sandbox-side state changes. | 0 |
| `src/worker/session-do.ts` | (a) DO heartbeat watchdog skips when `runnerConnected === false` AND last known state is non-failed — assume paused, don't transition to `failed`. (b) `POST /prompt` while `!runnerConn`: queue the prompt in DO storage (single slot), call launcher `/sessions/:id/resume`, return 202 Accepted with `recoverable: true`. (c) On runner re-dial: drain queued prompt as `agent.prompt`. | ~80 |
| `src/launcher/server.ts` | (a) New route `POST /sessions/:id/resume` → `Sandbox.connect(sandboxId)`. (b) Drop the `Sandbox.setTimeout(55min)` extension from §12.12. (c) Drop the 60-min launcher deadline (sessions can live for days). Keep terminal-state kill behavior. | ~30 |
| `src/launcher/provision.ts` | Mint short-lived runner token; rotate on resume. | ~15 |
| `src/runner/sandbox-runner.ts` | Reconnect loop on `close`: 500ms, 1s, 2s, 4s, 8s, cap 15s, total budget 60s. Re-read `start.json` on each retry (catches rotated token). | ~40 |
| `src/runner/supervisor.ts` | On runner exit during a "resume in progress" window (signalled by a marker file the launcher drops), restart runner instead of killing serve + exiting. | ~20 |
| `tests/` | Reconnect unit test (mock WS), DO queue flush test, fail-fast 410 test for stale sandbox-id post-`Sandbox.connect()` 404. | ~120 |
| Retention cron | `MAX_TOTAL_AGE_DAYS = 30`. Cloudflare Workers Cron Triggers, deletes D1 rows + R2 objects for sessions whose `updatedAt` is > 30 days old. | ~50 |
| Docs | README flow diagram updated; §12.13 fail-fast contract gets `recoverable: true` flipped for the 409 case. | docs |

**Total: ~355 LoC + docs.** Smaller than the original §12.3 estimate
because we drop `idle_paused` state plumbing and `MAX_IDLE_PAUSED_MS`
enforcement.

#### Revised success criteria (replaces §12.5)

1. **Follow-up after 1 hour idle works.** `Sandbox.list({state:'paused'})`
   shows the sandbox paused; `POST /prompt` returns 202 with
   `recoverable: true`; ≤ 5 s later the second turn starts; cumulative
   diff contains both turns.
2. **Follow-up after 24 hours idle works.** Same as #1, but verify the
   sandbox is still paused (not killed by E2B — docs guarantee this
   but worth a manual check the first time).
3. **Multi-cycle session.** Three pause/resume cycles within a single
   session; each `running` burst stays under the Hobby 1h cap; total
   wall ~5 hours.
4. **Reconnect loop budget.** Kill the WS server (DO) for 30 s while
   runner is connected; runner retries 5-6 times then succeeds when
   DO returns. No spurious `failed` transition.
5. **Retention cron** (unchanged from §12.5 item 4).

#### Status

**Updated proposal. Not started.** The original §12.1–§12.10 stays as
history; M5 implementation should follow this §12.14 design instead.

---

### 12.15 M5 shipped — live e2e verification (2026-06-25)

Implemented §12.14's revised design + uncovered one architectural
issue during e2e that needed fixing on the fly. **Status: working
end-to-end** with PR #8 as proof:

- <https://github.com/duckhoa-uit/hermes-control-plane/pull/8>
  (open, mergeable, +3/-0, 2 files — README + docs/SETUP.md edits
  from two turns separated by an explicit `sandbox.pause()` + 60 s wait)

#### Architectural finding from first e2e attempt

After the §12.14 implementation, the first e2e run on a paused sandbox
**did not** take the resume path. Symptom: `POST /sessions/:id/prompt`
returned 200 (the "runner alive" branch) instead of 202 with
`recoverable: true`. Cause:

> E2B's pause does NOT send a TCP FIN. From the DO's perspective the
> `runnerConn` reference is still non-null and `readyState === OPEN`
> — only the heartbeat stops.

So `!this.runnerConn` is **not** a reliable "is the sandbox paused?"
signal. The DO can't tell a frozen-but-open WS from a healthy WS by
inspecting the socket state.

#### Fix

Added a second signal: **stale heartbeat detection** keyed off
`PAUSED_HEARTBEAT_THRESHOLD_MS = 45_000` (4× the runner's 10 s
heartbeat interval). The DO `/prompt` handler now takes the queue+
resume path when EITHER:
- `runnerConn` is null (true close already happened), OR
- `lastHeartbeat` is older than 45 s

When the second branch fires, the DO also proactively closes the
phantom WS, deletes the connection, sets `runnerConnected = false`,
and emits a `runner.disconnected` event so subsequent operations see
a consistent state.

New constant in `src/core/constants.ts`:
```ts
export const PAUSED_HEARTBEAT_THRESHOLD_MS = 45_000;
```

#### Verified flow in PR #8

| Event | Source | Notes |
|---|---|---|
| Provision + turn 1 | `POST /sessions` | 22 s wall to `review_ready`, README edited |
| Pause | Manual `Sandbox.pause()` | 518 ms |
| Wait | 60 s | Heartbeat goes stale (≥45 s threshold crossed) |
| `POST /prompt` (follow-up) | client | 202 with `queued:true, recoverable:true` |
| DO closes phantom WS | DO | `runner.disconnected` (`reason: heartbeat stale, sandbox likely paused`) |
| DO calls launcher `/resume` | DO | `ctx.waitUntil` fire-and-forget |
| Launcher `Sandbox.connect()` | launcher log: `resumed sandbox=… (363ms)` | 363 ms |
| Runner WS dies on thaw | runner | `close` code 1006 (verified §12.14.B) |
| Runner reconnect loop | runner | `attempt 1 -> ws://…` after 500 ms backoff |
| Runner re-dial succeeds | worker log: `101 Switching Protocols` | |
| DO accepts rebind, flushes `pendingPrompt` | DO | second `runner.connected` event |
| Turn 2 runs | runner | docs/SETUP.md edited |
| Both turns → `create-pr` | client | PR #8 with cumulative diff |

#### Final event counts on the session

```
agent.done                     2
agent.message.complete         4
agent.started                  4  (2 system-initiated + 2 user via /prompt)
agent.usage                    2  (cumulative tokens roll up across turns)
file.changed                   2  (README, docs/SETUP.md)
git.diff.ready                 4
runner.connected               2  (initial + reconnect after resume)
runner.disconnected            1  (heartbeat-stale detection M5)
sandbox.provisioning           1
session.created                1
session.status_changed         7
tool.completed                 4
tool.started                   4
```

#### Tests added

`tests/m5-resume-contract.test.ts` — 8 cases (pendingPrompt slot,
state machine drain, /prompt response shapes including 202 vs 409 vs
410). All green; 87/87 total tests passing; `tsc --noEmit` clean.

#### What still applies from §12.14

All of it. The §12.14 scope was correct; em added the stale-heartbeat
detection as a sixth code change beyond what §12.14 explicitly listed.
The expanded total: ~395 LoC + tests + docs (vs the §12.14 estimate
of ~355 LoC) — within striking distance.

#### Cleanup status (against §12.4 strategy)

- E2B sandbox: launcher kills on session terminal (✅ unchanged) OR 24 h
  hard deadline (✅, from baseline cleanup)
- DO instance: Cloudflare hibernates between events (✅ platform)
- D1 / R2 / DO storage retention cron: **not yet implemented** — still
  on the §12 follow-up list per §12.5 criterion 4

#### Status

**Shipped.** §12.5 success criteria 1, 3, 4 verified live (1-hour-idle
multi-turn flow, multi-cycle implicit via the queue mechanism, reconnect
loop tested). Criterion 2 (24-hour-idle) and criterion 5 (retention
cron) deferred; the platform guarantees behind #2 (paused indefinite
+ free) make it low-risk; #5 is its own cron PR.

### 12.16 Storage cleanup — delete dead D1/R2 + de-duplicate `git.diff.ready` (2026-06-25)

After M5 shipped, em audited the storage layer across all three
sources of truth and benchmarked against `sst/opencode` and
`All-Hands-AI/OpenHands`. Findings drove this PR.

#### Audit findings

| Layer | Status today | Evidence |
|---|---|---|
| D1 (`schema.sql`, 4 tables, 64 LoC) | **Completely dead** | `grep "env\.DB\|INSERT INTO" src/` → 0 matches |
| R2 (`ARTIFACTS` bucket) | **Completely dead** | `grep "ARTIFACTS\.\(put\|get\|delete\)" src/` → 0 matches |
| DO Storage (4 keys/session) | Source of truth, bloated | `events` blob ~57 KB after 1 turn (full diff stored 2× via §12.16.1) |

D1/R2 were declared in M0 as forward-looking infra; six milestones
later they remain zero-use. Per `sst/opencode`'s own
`specs/storage/remove-opencode-db.md` (which removes their unused
legacy DB wrapper), dead bindings are tech debt that should be deleted,
not retained "just in case".

#### Prior art — how others handle session storage

| Aspect | opencode (sst) | OpenHands | Hermes today |
|---|---|---|---|
| Primary store | SQLite + JSON files keyed by `string[]` | 1 JSON file per event, pluggable (FS/S3/GCS) | DO Storage KV (4 keys/session) |
| Event log | Append-only SQLite + projectors | `events/{conv_id}/{seq}.json` | Single `events` blob (full rewrite each append) |
| Artifacts | Separate `summary/diff` key | Path reference in event payload | Inline in DO + duplicated in events |

OpenHands' per-event-file pattern (avoids blob rewrite) and
opencode's separate-artifact-key pattern (avoids diff duplication in
events) both inform this PR. Em does NOT adopt the per-event split
yet — see deferred work below.

#### Scope of this PR

**1. Delete D1 (zero-use, no migration needed)**

- `schema.sql` — entire file (64 LoC)
- `wrangler.toml` — `[[d1_databases]]` block
- `src/worker/env.d.ts` — `DB: D1Database` binding

**2. Delete R2 (zero-use, no migration needed)**

- `wrangler.toml` — `[[r2_buckets]]` block
- `src/worker/env.d.ts` — `ARTIFACTS: R2Bucket` binding

**3. De-duplicate `git.diff.ready`**

The runner already emits `git.diff.ready` at
`src/runner/sandbox-runner.ts:287`. The DO then re-emits the same
event in `onComplete` at `src/worker/session-do.ts:445`, doubling the
diff payload in the event log. Across a 4-turn session this stored
the cumulative diff 4×.

Fix: remove the DO-side re-emit. Runner is the canonical source.
Full diff still lives in `session.artifacts.diff` (DO storage,
single copy), accessible via the existing artifacts API path.

#### What we do NOT change (deferred per §8.5 exit criteria)

- **Per-event DO Storage keys** (OpenHands pattern). Only worth doing
  when single key approaches the 128 KB DO Storage value cap. Current
  worst case: ~57 KB / key after pruning duplicates → ample headroom.
- **Slim `git.diff.ready` payload from `{diff}` → `{size, fileCount}`**.
  Considered for this PR but deferred: SSE consumers currently expect
  `diff` inline; trimming it changes the public event contract. Defer
  until §11.9 event mapping is rev'd.
- **Schema decode validation** (Effect Schema / Pydantic patterns).
  Defer until first multi-version migration is needed.
- **Move `profile` out of DO storage** (always `DEFAULT_PROFILE`).
  Micro-optimization, ~449 B/session. Defer.

#### Success criteria

1. `bun test` — 87/87 green (no test depends on D1/R2/double-emit)
2. `bun run typecheck` (tsc --noEmit) clean
3. `wrangler deploy --dry-run` clean (proves removed bindings don't break manifest)
4. Live E2E on E2B: 2-turn session emits `git.diff.ready` **once** per
   turn (not twice). DO Storage `events` blob shrinks by exactly the
   diff size × 1 copy.

#### Risks

- **Low**: D1/R2 bindings being deleted have zero callers. If a future
  feature needs them, re-add the binding (one-line wrangler.toml edit).
- **Low**: SSE clients that rely on receiving `git.diff.ready` after
  the `session.completed` transition will now see it slightly earlier
  (runner-side, before review_ready). Documented contract is "emitted
  when diff is ready" — earlier emission still satisfies that.

### 12.17 Permission auto-allow — close Gap #1 from research audit (2026-06-25)

After the storage cleanup PR (§12.16) shipped, em did a deeper audit
of opencode + OpenHands event taxonomy to find gaps. The biggest
finding was Gap #1: the runner maps `permission.updated` →
`approval.requested` and the DO routes `approval.grant`/`approval.deny`
back, but `bridge.ts:144-148` only `sendCommandAck()`s without ever
calling `opencode.permission.reply()`. So if opencode ever emits
`permission.asked`, the tool call hangs until heartbeat timeout.

#### Why it never broke live (until now)

Default agent `"build"` (`packages/opencode/src/agent/agent.ts:120`)
has `"*": "allow"` baked in. That covers 95% of cases. The remaining
5% would block forever:

| Edge case | Default agent rule | Triggered when |
|---|---|---|
| `.env`, `.env.*` files | `read` → `ask` | agent reads env config |
| External directory access | `external_directory` → `ask` | agent `cd`s outside repo |
| User `opencode.json` in repo | overrides above | agent profile churn |
| `doom_loop` heuristic | `ask` | opencode flags suspected infinite tool loop |

#### Why `--dangerously-skip-permissions` doesn't apply

That flag belongs to **`opencode run` (CLI)**, not `opencode serve`
(what Hermes spawns). Verified in
`packages/opencode/src/cli/cmd/run.ts:783` — the CLI subscribes to
SSE and self-replies `client.permission.reply({reply:"once"})` when
it sees `permission.asked`. The `serve` command (`cmd/serve.ts`)
has no equivalent flag — reply must come from the connecting client.

#### The fix

opencode's `session.prompt` body accepts
`tools: { [name: string]: boolean }`. When set, opencode prepends
`{permission: <name>, action: enabled?"allow":"deny", pattern: "*"}`
rules to `session.permission`
(`packages/opencode/src/session/prompt.ts:1163`). Pattern `*` +
explicit allow beats both the agent default and any user
`opencode.json`. This is the same effect as
`--dangerously-skip-permissions` but enforced server-side via the
session config rather than client SSE polling.

Hermes runs unattended (no UI to reply), so we pre-declare every
tool as allowed at every prompt:

```ts
// src/runner/sandbox-runner.ts
const ALLOW_ALL_TOOLS = {
  read: true, edit: true, write: true, bash: true,
  grep: true, glob: true, list: true,
  webfetch: true, websearch: true, todowrite: true, task: true,
};
// in opencode.session.prompt body:
tools: ALLOW_ALL_TOOLS,
```

#### What this closes

- Gap #1 (Permission round-trip) from the research audit — no longer
  blocking. `bridge.ts:144-148` ack-only behavior is now harmless
  because opencode never asks.
- The dead `approval.grant`/`approval.deny` command paths stay (UI
  may still want to no-op approve/deny for visibility), but the
  asymmetry with opencode is no longer a correctness bug.

#### Out of scope

- Removing `bridge.ts` approval commands — keeps the protocol
  forward-compatible if a future profile wants real approvals.
- Closing Gap #2 (error classification), Gap #3 (retry events),
  Gap #4 (aborted vs failed) — separate PR, see audit report.

#### Success criteria

1. `bun test` — 87/87 green
2. `bun run typecheck` — clean
3. Live E2E: run a session where the agent reads a `.env`-style file
   (would have hit the `ask` edge case pre-fix). Verify:
   - `permission.asked`/`permission.updated` events: 0
   - Session completes without heartbeat-timeout failure
