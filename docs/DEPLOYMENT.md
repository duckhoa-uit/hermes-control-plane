# Hermes Control Plane — Deployment Plan & Release Document

Status: proposal · Owner: core team · Last updated: 2026-06-25

This document is the deployment plan for shipping `hermes-control-plane`
to a real, multi-user environment, including: (1) where each process runs,
(2) how we cut a release, (3) how Hermes (the existing agent) integrates,
and (4) how to use it from the Slack app that is already connected to
Hermes.

Scope:

- Solo-engineer MVP today (see `ROADMAP.md §8`) graduating to a small team
  on a Slack channel. Not aiming at Ramp-scale yet.
- Hobby tier E2B; upgrade to Pro is a config flip, not a re-architecture.
- We deliberately keep the surface small. Anything not listed here is out
  of scope for the first release.

---

## 1. What we learned from the field

We surveyed open-source background-agent codebases before writing this
plan. Only the patterns we are actually adopting are listed; everything
else stays in `ROADMAP.md §5` (out of scope).

| Project | Pattern we keep | Pattern we drop |
|---|---|---|
| **Ramp Inspect** (blog) | DO-per-session, supervisor-in-snapshot, OpenCode SDK + SSE, prompt queue, snapshot resume, Slack-first UX, GitHub webhooks for state ground truth, "% sessions → merged PR" north-star metric | Per-repo image registry + 30-min rebuild loop (overkill for one team), Chrome extension, computer-use streamed desktop |
| **OpenCode** (`sst/opencode`) | We *are* the consumer of OpenCode — pinned `opencode-ai@1.17.10` + `@opencode-ai/sdk@1.17.10`, `opencode serve` baked into the E2B snapshot, `client.event.subscribe()` SSE drives the runner (see `ROADMAP.md §11.8–11.11`) | We do not host the OpenCode TUI for end users |
| **OpenHands** (`All-Hands-AI/OpenHands`) | Headless runtime in a sandbox, single long-lived agent process, event-driven bridge to a control plane, explicit "session = container" lifecycle, structured event types on a single bus | Multi-container/k8s runtime; we stay on E2B. We do not adopt OpenHands' own event vocabulary — `HermesEventType` already covers it |
| **Aider / `principled-ai-coding` / `block/goose`** | Stateless CLI invocation per turn is a dead end for tool-fidelity events — confirms our M4 decision (SDK + SSE, not stdout parsing) | — |
| **Devin-style hosted clouds** | Operational shape: separate "control plane" (HTTP+state) from "agent runtime" (sandbox); audit log is append-only and replayable | Their proprietary VM-pool primitive (we lean on E2B for this) |

**Inspect-specific things we adopt directly** (all of these are already
shipped or in-flight, not new asks of this plan):

- One Durable Object per session, treated as the only source of truth.
- Supervisor in `setStartCmd`; runner exec'd on `/opt/control-plane/start.json`.
- `opencode serve` baked into the snapshot — verified surviving
  pause/resume with the same PID and warm cache (`ROADMAP.md §11.8.B`).
- Author-attributed events (`author_user_id` on `session_events`, populated
  from the Slack user id; required for multi-user — §6.2).
- Single-user GitHub PAT (P1.1) for `git push` + `POST /pulls`; the PR
  `author` is the real user. No GitHub App involved.
- `% sessions → merged PR` as the only release-quality metric.

What we explicitly do **not** copy from Inspect at this stage:

- Per-repo image registry. We ship one `control-plane-runner` template. Per-repo
  templates revisit only when build/test setup actually varies enough to
  matter (`ROADMAP.md §8.5` exit criteria).
- Warm sandbox pool. E2B's ~700–1500 ms cold start is acceptable for a
  Slack-paced UX.
- Browser-based code-server inside the sandbox. Slack + the GitHub PR is
  the UI for release 1.

---

## 2. Topology for the first release

Three logical components, three deploy targets:

```
┌───────────────────────────┐
│ Slack workspace           │
│  Hermes Slack app         │  ── existing, already connected to Hermes
└──────────────┬────────────┘
               │ events.api / slash command
               ▼
┌───────────────────────────┐         ┌───────────────────────────┐
│ Hermes agent (existing)   │  HTTPS  │ hermes-control-plane      │
│  - conversation memory    │ ──────▶ │  Worker (Cloudflare)      │
│  - intent router          │         │  + DO per session         │
│  - "code task" intent     │ ◀────── │  + WS event hub           │
│    → POST /sessions       │  WSS    │                           │
└──────────────┬────────────┘         └────────────┬──────────────┘
               │                                   │ HTTPS
               │ status updates                    ▼
               │ (Block Kit)            ┌───────────────────────────┐
               ▼                        │ control-plane-launcher (Bun)     │
        Slack thread                    │  - E2B SDK + GH PAT       │
                                        │  - per-session reaper     │
                                        │  - orphan sweeper         │
                                        └────────────┬──────────────┘
                                                     │ E2B SDK
                                                     ▼
                                          ┌───────────────────────────┐
                                          │ E2B sandbox               │
                                          │  supervisor + runner      │
                                          │  + opencode serve         │
                                          └───────────────────────────┘
```

### 2.1 Where each process runs

| Component | Runtime | Deploy target | Why |
|---|---|---|---|
| Worker + DO + WS hub | Cloudflare Workers | `wrangler deploy` | Already on CF; free tier covers the control plane. |
| Launcher sidecar | Bun 1.3+ | Single VM (Fly Machine / Hetzner CX22 / Railway) | Holds the E2B API key + the user's GitHub PAT; `workerd` cannot drive the E2B SDK (see `ROADMAP.md §9.2`). One process is fine for ≤ 10 concurrent sessions. |
| E2B sandbox | E2B Hobby (Pro after §6) | E2B cloud | Throwaway per session. |
| Hermes agent | (existing infra) | (existing infra) | Out of scope for this repo — we only define the contract. |
| Slack app | Slack | (existing) | Already connected to Hermes; we add one outbound call. |

### 2.2 Why a single launcher VM, not multiple

The launcher is the only stateful piece outside the DO. Multiple launchers
would have to coordinate the orphan sweeper and the per-second E2B
creation cap. Both are cheap as a single process today and become real
problems only above Pro-tier concurrency. Decision: **single launcher
per environment** for release 1; add a leader-elected pair only if the
single instance becomes a bottleneck or a 9s problem.

---

## 3. Environments

Three environments, identical shapes, different secrets:

| Env | Worker | Launcher | E2B template | Slack workspace |
|---|---|---|---|---|
| `dev` | `wrangler dev` + ngrok | local `bun run launcher` | `control-plane-runner` Hobby | dev workspace, channel `#hermes-dev` |
| `staging` | `hermes-staging.workers.dev` | small VM | `control-plane-runner-staging` Hobby | dev workspace, channel `#hermes-staging` |
| `prod` | `hermes.workers.dev` (or custom domain) | dedicated VM | `control-plane-runner-prod` Hobby (Pro after §6.4) | prod workspace, channel chosen by team |

Promotion rule: a release tag must have run clean in `staging` against a
real PR for ≥ 24 h before being deployed to `prod`. No exceptions for
runner or supervisor changes — they ship inside the E2B snapshot and are
the highest-blast-radius change in the system.

---

## 4. The release pipeline

Each release ships **three artifacts** atomically. They are all built from
the same git tag.

1. **Worker bundle** — `wrangler deploy --env <env>`.
2. **Launcher binary / image** — `bun build src/launcher/server.ts
   --target=bun --outfile dist/launcher.js`, deployed to the launcher VM.
3. **E2B template** — `bun run template:build` writes
   `infra/e2b/dist/template-id.txt`; the new id becomes
   `E2B_TEMPLATE` in the launcher's environment.

### 4.1 Versioning

We use a single monorepo version (`package.json#version` →
`CONTROL_PLANE_RELEASE` env var on both Worker and launcher). The template
inherits the tag in its alias: `control-plane-runner-prod-v0.3.1`. This makes
every running sandbox traceable to a git tag from the E2B dashboard.

### 4.2 Tag → ship

```
git tag v0.3.1
git push --tags
```

CI (GitHub Actions, one workflow):

```yaml
jobs:
  test:        bun test && bun run typecheck
  template:    bun run template:build         # only if infra/ or runner/ changed
  worker:      wrangler deploy --env staging
  launcher:    ssh launcher-staging './deploy.sh $TAG'
  smoke:       scripts/release-smoke.ts staging   # POST /sessions against a sentinel repo
  promote:     manual approval gate → repeat worker+launcher with --env prod
```

`scripts/release-smoke.ts` (new, ~50 LoC): posts a one-line README edit
against a sentinel repo, waits for a real PR, asserts `merged=false,
mergeable=true`, deletes the branch. Failure aborts the promote step.

### 4.3 Rollback

- **Worker**: `wrangler rollback` (CF stores previous bundles).
- **Launcher**: keep the previous binary on the VM as `launcher.js.prev`,
  `systemctl restart control-plane-launcher` with the env pointing at it.
- **E2B template**: aliases are immutable per-version. To roll back, set
  `E2B_TEMPLATE=control-plane-runner-prod-v<prev>` in the launcher env. No
  rebuild needed.

The rollback target is **always the previous green release tag**, not
"latest minus one commit". This is enforced by the smoke gate.

### 4.4 Secrets

Lifted from `.dev.vars.example` and `wrangler.jsonc`. Owners and rotation
cadence:

| Secret | Where | Owner | Rotation | Notes |
|---|---|---|---|---|
| `E2B_API_KEY` | launcher VM env | infra | quarterly | rotate via E2B dashboard, hot-swap env, restart launcher |
| `ZAI_API_KEY` | launcher VM env | infra | quarterly | Forwarded into the sandbox; supervisor applies it to opencode via `auth.set` |
| `GITHUB_USER_TOKEN` (fine-grained PAT) | launcher VM env | infra | every 90 days | P1.1 single-user OAuth. Runner uses it for `git push` + `POST /pulls`; PR `author` is the real user. |
| `CONTROL_PLANE_BASE_URL` | launcher VM env | infra | n/a | the Worker URL; static per env. Used both for launcher→Worker calls and as the WS dial-back URL given to the runner inside the sandbox. |
| Slack signing secret + bot token | Hermes agent infra | Hermes team | yearly | not in this repo |

Secrets that *do* live in the Worker (post-P1.1): the GitHub OAuth
client secret and the OAuth token encryption key. Everything else (E2B, Z.AI, `GITHUB_USER_TOKEN`) is launcher-only. The Worker is the right place
for OAuth secrets because the OAuth dance terminates there
(`/auth/github/callback`).

**Rotation logistics** (kept here as the canonical reference; SETUP §10.3
moved into this section):

- `GITHUB_USER_TOKEN` (PAT): rotate every 90 days. Restart launcher to
  pick up the new value. In-flight sessions started with the old token
  finish on the old token (the token is captured in the sandbox env at
  provision time).
- `E2B_API_KEY`, `ZAI_API_KEY`: same pattern — replace env + restart
  launcher.

---

## 5. Operational guardrails (already in code, called out for release)

These are not new asks; they are the safety net the release relies on.
Listed so the on-caller knows what each one protects against.

| Guardrail | Where | Protects against |
|---|---|---|
| `MAX_CONCURRENT_SESSIONS=10` | `wrangler.jsonc` + launcher env | E2B Hobby cap exhaustion |
| Launcher hard deadline = 24 h | `src/launcher/server.ts` (`watchSession()`) | runaway-job backstop (paused sandboxes are free and indefinite per §12.14, so this is purely a GC ceiling, not a follow-up window) |
| `HEARTBEAT_TIMEOUT_MS=15 min` | `wrangler.jsonc` (bumped 60 s → 15 min in ROADMAP §12.7) | runner stall (transitions to `stalled → failed`); matches E2B's 15-min auto-pause window so short idles don't fire false stalls |
| Orphan sweeper at boot | `src/launcher/sweeper.ts` | leaked sandboxes after launcher crash |
| Session-scoped runner token | minted in DO, dropped in `start.json` | broad-credential exposure inside the sandbox |
| User-OAuth PAT scoped per-repo, baked into `.git/config` of the per-session sandbox only | `src/launcher/provision.ts` step 3 | long-lived GH credentials never leave the launcher VM long-term |
| Sandbox auto-pause on idle (15 min) | `Sandbox.create` lifecycle | wasted E2B compute |
| ~~Per-session turn cap~~ | ~~DO~~ | ~~runaway loops under full auto-allow~~ — explicitly **skipped** for the 1-user release; see `ROADMAP.md §8.4` for the survey of peers (OpenHands/Aider/Cline/SWE-agent) and trigger criteria for revisiting |

**Action for release** (resolved 2026-06-25): no turn cap to ship. The
wall-clock backstops (E2B 1 h continuous, launcher 24 h hard deadline,
heartbeat 15 min, `MAX_CONCURRENT_SESSIONS = 10`) plus the Z.AI flat-rate
plan make a per-session turn count cap non-essential for the 1-user
release. The decision and the revisit triggers are documented in
`ROADMAP.md §8.4`. If any trigger fires in production, port Cline's
`LoopDetectionTracker` (pattern-based, ~100 LoC) — that is the preferred
shape over a raw counter.

---

## 6. Integration with the Hermes agent

The Hermes agent already does conversation + intent routing. The integration
adds one outbound HTTP capability and one inbound WebSocket subscription.

### 6.1 Contract

Hermes treats the control plane as a **tool** with three operations.
Nothing else. The control plane stays repo-agnostic; Hermes owns the
"which repo, which user, which Slack thread" mapping.

| Op | Direction | Endpoint | Body | Returns |
|---|---|---|---|---|
| `start_coding_task` | Hermes → launcher | `POST http://launcher/sessions` | `{ taskDescription, repoUrl, projectId?, baseBranch?, actor: { hermes_user_id, github_user_id, slack: { channel, thread_ts, user_id } } }` | `{ sessionId, sandboxId, streamUrl, stateUrl }` |
| `stream_session_events` | Hermes ← Worker | `WS streamUrl` | — | live `HermesEvent`s, replayable from `seq=0` |
| `follow_up_prompt` | Hermes → Worker | `POST <worker>/sessions/:id/prompt` | `{ text, actor: { hermes_user_id, github_user_id } }` | `200` / `202 recoverable` / `409` / `410` |
| `abort_coding_task` | Hermes → launcher | `DELETE http://launcher/sessions/:id` | — | `204` |

`actor.hermes_user_id` is Hermes' stable identifier; `actor.github_user_id`
is the GitHub login that owns the OAuth token in DO storage (looked up by
the Worker before any `git push`). `slack: { channel, thread_ts, user_id }`
is forwarded into the DO's session metadata; the Worker does not call Slack
itself — Hermes remains the only thing holding the Slack bot token.

### 6.2 New code in this repo for the integration

Three things land before release 1. Each is one PR.

1. **Actor block on session-mutating routes.** `POST /sessions`,
   `POST /sessions/:id/prompt` accept an optional `actor: { hermes_user_id,
   github_user_id, slack? }`. Stored on the `session` record and echoed on
   every event as `event.author_user_id = actor.github_user_id`. Drops the
   single-owner assumption (ROADMAP P3.1).
2. **User GitHub OAuth for PR creation (P1.1).** ✅ Shipped. Launcher
   bakes the user PAT into `.git/config` of the cloned repo
   (`src/launcher/provision.ts` step 3 — "Option A"); the runner pushes
   the branch and calls `POST /repos/{owner}/{repo}/pulls` with the
   same token, then emits `pr.created`. Authorship + pusher = the real
   user. GitHub's UI shows the user as PR author, which is what
   branch-protection's "no-self-approve" rule reads. (Full multi-user
   OAuth dance is item 3 below — still pending.)
3. **OAuth dance routes on the Worker.** `GET /auth/github/start?return_to=…`
   and `GET /auth/github/callback`. Tokens stored AES-256-GCM-encrypted in
   the DO `users` namespace, keyed by `github_user_id`. No D1 — see
   §12.16. Refresh on `Bad credentials` from the GitHub API.

See §11 ROADMAP P1.1 for the locked code shape and `tests/oauth.test.ts`
acceptance list.

### 6.3 Hermes-side changes (out of repo, called out for the team)

- Add a `code_task` tool / intent. Hermes recognises "fix bug …", "add
  endpoint …", etc. against a routed repo and calls
  `POST /sessions`.
- On `sessionId` return: post a Slack reply ("Working on it — thread will
  update") and subscribe to the WS stream.
- Map event types to Slack messages:

  | Event | Slack action |
  |---|---|
  | `session.created`, `session.ready` | Block Kit "started" card |
  | `agent.message.delta` | (debounced 1s) edit the running "working…" message; do **not** post per delta |
  | `tool.started` / `tool.completed` | "ran `<tool>`" (collapsed) |
  | `file.changed` | accumulate; show at PR time only |
  | `approval.requested` | post a Block Kit approve/deny button (after P2.1 ships) |
  | `pr.created` | "PR: <url>" with file count + token usage |
  | `session.failed`, `session.aborted` | "<reason>" + a "retry" button that re-posts the same prompt |

- Mid-thread follow-up messages from the same user → `POST
  /sessions/:id/prompt` (Worker route already exists).
- Abort button → `DELETE /sessions/:id`.

### 6.4 Concurrency budget

Hermes' "code task" intent must respect the launcher's cap. Cheap
implementation: on a `429` from `POST /sessions`, Hermes replies
"queue is full, retry in a moment" in-thread; no internal queue.

Once we cross 5 sessions/day per user or 30 sessions/day total we move
E2B to Pro (`$150/mo`, 100 concurrent), bump
`MAX_CONCURRENT_SESSIONS` to 50, and revisit `ROADMAP.md §P0.3` warm
pool.

---

## 7. Slack app usage (end-to-end)

The Slack app already connected to Hermes does not need new scopes for
the basic flow. Recommended additions are listed where they unlock UX.

### 7.1 Required Slack scopes (existing)

`chat:write`, `chat:write.public`, `app_mentions:read`,
`im:history` (for DMs), `commands` (if we add slash commands),
`reactions:write` (for status emoji). These are already granted to the
Hermes app — confirm before release.

### 7.2 User journey

0. **First time only:** user `@mentions` Hermes; Hermes calls
   `GET /auth/github/start?return_to=slack://…` and DMs back an
   ephemeral link. User completes GitHub OAuth (`repo` scope). DO
   stores the encrypted token under the user's GitHub login.
   Subsequent steps assume this has happened — Hermes blocks
   `code_task` until it has.
1. User `@mentions` Hermes in a channel, or DMs it:
   > `@hermes in acme/backend, add rate-limiting middleware to /v1/login`
2. Hermes' intent router recognises this as `code_task`. It resolves
   `acme/backend` against the user's allow-list (existing Hermes
   capability) and calls `POST /sessions` with
   `actor: { hermes_user_id, github_user_id, slack: { channel, thread_ts, user_id } }`.
3. Hermes posts in-thread: "On it — I'll update this thread as I work."
4. The launcher provisions an E2B sandbox; the runner connects; the
   agent works. Hermes streams concise updates into the thread.
5. On `pr.ready` (runner) the Worker opens the PR using the user's
   OAuth token (so the PR `user` field is the real user). Hermes posts
   the PR URL in-thread.
6. On review comments (after `P1.2` webhooks ship), Hermes resumes the
   session and addresses the comment in-thread.

### 7.3 Authoring rule (release blocker — shipped under P1.1)

PRs are authored by the **real user** via a fine-grained PAT (P1.1).
The same token does both `git push` and `POST /pulls`, so author =
pusher = real user. Concretely on GitHub:

- `pull_request.user.login` = `$GITHUB_USER_LOGIN`
- Branch protection's "PR review by someone other than author" rule
  works because the author is a real human, not a bot.

If the user does not have an OAuth token on file, `POST /sessions`
returns **412 Precondition Failed** with `{ error: "user not
authenticated", auth_url: "/auth/github/start?…" }` — Hermes DMs the
link and does not create a sandbox.

### 7.4 Slash command (optional, recommended)

Add `/hermes status [sessionId]` that hits `GET /sessions/:id` and
posts the current state + last 5 events into the channel. Cheap to
build (~30 LoC in Hermes); useful when a thread has scrolled.

---

## 8. Observability for release

Minimum metrics on day one. Anything richer is `ROADMAP.md §P4`.

| Metric | Source | How it surfaces |
|---|---|---|
| `sessions_total` | DO storage, summed across sessions | `GET /metrics` on the Worker (new, ~30 LoC) |
| `sessions_merged` | webhook (`ROADMAP §P1.2`) or manual until then | same |
| `merge_rate` | `sessions_merged / sessions_total` (7-day window) | same |
| `p95_time_to_first_token` | DO event log delta `created → first agent.message.delta` | same |
| `humans_prompting_5m` | unique `author_user_id` in last 5 min | same |
| Launcher health | existing `/health` | uptime check (UptimeRobot free) |
| Sandbox count | E2B dashboard | weekly eyeball |

Logs:

- Worker logs → Cloudflare Logpush to an S3-compatible bucket.
- Launcher logs → `journald` on the VM, shipped via `vector` (or just
  ssh + grep until volume justifies more).

Alert rules (PagerDuty-free, just Slack DM to the on-caller):

| Condition | Action |
|---|---|
| `launcher /health` 3 consecutive failures | Slack DM |
| `merge_rate` < 30 % over 24 h (after we have >= 10 sessions/day) | Slack channel post |
| `p95_time_to_first_token` > 8 s over a 1 h window (warm-cache regression) | Slack channel post |
| Any session in `creating_pr` > 10 min | Slack DM (means PR flow stuck) |
| Orphan sweeper killed > 5 sandboxes at boot | Slack channel post (means launcher crashed badly) |

---

## 9. Pre-release checklist

Run this top-to-bottom for each promotion (staging → prod). No
shortcuts.

- [ ] `bun run test` → 100/100 (or current number) passing; `bun run e2e:real` → 37/37 against `bunx wrangler dev`
- [ ] `bun run typecheck` → clean
- [ ] E2B template built and tagged with the release version
- [ ] `wrangler deploy --env <env>` → succeeds
- [ ] Launcher binary deployed; `curl https://launcher/<env>/health` → ok
- [ ] `scripts/release-smoke.ts` end-to-end → PR opened on the sentinel
      repo, sandbox killed, E2B list empty afterwards
- [ ] `GITHUB_USER_TOKEN` set on the launcher; PAT has Contents + Pull-requests RW on the target repos
- [ ] GitHub OAuth app created; `GITHUB_OAUTH_CLIENT_ID`/`_SECRET` set as
      Worker secrets (`wrangler secret put`)
- [ ] `OAUTH_TOKEN_ENCRYPTION_KEY` minted (`openssl rand -base64 32`) and
      set as Worker secret; backed up in Vault
- [ ] Branch protection on prod repos requires PR review from someone
      other than the PR author (works correctly now that author = real
      user, not the App)
- [ ] First user has completed the OAuth dance against the prod Worker;
      `GET /users/me/github` returns `{ ok: true, login: "<user>" }`
- [ ] Slack app's `code_task` intent points at the new Worker URL
- [ ] Rollback target tag identified and noted in the release ticket
- [ ] On-caller named in the release ticket; lives in the Slack channel
      for 24 h post-deploy

---

## 10. What we are deliberately not doing in release 1

Recorded so we stop relitigating:

- **Warm pool, per-repo templates, snapshot-based session forking.**
  E2B cold-start (~1 s) is acceptable; ship without and revisit on the
  exit criteria in `ROADMAP.md §8.5`.
- **Web UI / code-server.** Slack + GitHub PR is the UI.
- **Multi-launcher HA.** Single VM with auto-restart is enough; the only
  state that matters survives in the DO.
- **Real cron-driven template refresh.** Manual `bun run template:build`
  is fine until template deps drift weekly.
- **GitHub webhooks driving session state.** Stub status display via
  manual polling; webhook ingestion is the very next milestone after
  release 1, not a release blocker.
- **Computer-use / streamed desktop / Chrome extension.** As `ROADMAP §5`.

**Single-user reminder** (merged in from SETUP §10.4):

There is no authentication on the Worker's session-mutating routes. Do
**not** expose the deployed Worker URL publicly without a Cloudflare
Access policy or equivalent (Zero Trust, IP allowlist, basic auth via a
front-end Worker). A second operator hitting `POST /sessions` would push
under your `GITHUB_USER_TOKEN`. Multi-user auth (per-user OAuth storage,
per-route auth) is the locked design in [`ROADMAP.md §14`](ROADMAP.md);
the 1-user mitigation is [§14 Cloudflare Access](#14-locking-the-deployed-worker-behind-cloudflare-access).

---

## 11. Decisions (closed open-questions)

These were marked as open in the original draft; resolved here so they
stop blocking the release ticket.

1. **Prod Slack channel** → the channel Hermes already lives in. No
   new channel created for release 1; reduces split-attention. If
   volume warrants splitting later, the channel id is a launcher env
   var (`CONTROL_PLANE_SLACK_DEFAULT_CHANNEL`), one-line change.
2. **Sentinel repo for `release-smoke.ts`** → a throwaway in the team
   GitHub org named `hermes-sentinel`. Public, README-only, branch
   protection off, single file `README.md`. Exercises the real user-PAT `git push` +
   PR-create path against a live remote — that coverage is exactly
   what we want before promoting to prod. A read-only test repo
   would miss the push code path.
3. **Launcher VM owner of record** → see [§11.1](#111-launcher-vm-owner-of-record-explainer)
   below for what this means and how to pick. Default for release 1:
   the Hermes tech lead, named in the release ticket.
4. **Release-quality metrics** → `merge_rate` AND
   `p95_time_to_first_token` as co-equal release metrics. Rationale:
   `merge_rate` alone is laggy (PRs sit unreviewed for days) and
   noisy at low N (one bad task tanks the ratio); time-to-first-token
   catches sandbox-cold-start / runner regressions inside a day,
   even with zero merged PRs. Both metrics live on the same
   `/metrics` route (§8).

### 11.1 Launcher VM owner of record — explainer

"Owner of record" is an operational role, distinct from "who pushes
the deploy". The launcher VM is the only place in the stack that holds
*long-lived* secrets in cleartext:

- `E2B_API_KEY` — full sandbox + billing control on the E2B account
- `GITHUB_USER_TOKEN` (fine-grained PAT) — push + open PR on the repos
  this PAT is scoped to
- `ZAI_API_KEY` — drains the Z.AI Coding Plan budget if abused

The owner is a **named human** with these responsibilities:

| Responsibility | What it actually means |
|---|---|
| **Custody** | Holds the offline backup of the PKCS#8 PEM (1Password / Vault item, sole owner). Knows the SSH keypair that gets into the VM. |
| **Rotation** | Owns the calendar reminders for quarterly key rotation (see §4.4 table). |
| **Incident response** | Named in `/etc/motd` on the VM and in the release ticket. If E2B billing spikes or a key leaks at 3 AM, this is the page target. |
| **Allow-list changes** | Approves which GitHub repos the App may be installed on, and which Slack workspaces Hermes may serve. |
| **Compliance contact** | If the team is ever subpoena'd / asked to disclose what a session did, this person is the records custodian. |

This is **not** the same as the CI service account that runs
`wrangler deploy` — that's a machine identity with no human at the
keyboard. The owner is the human who can re-issue the CI account's
credentials if it gets compromised.

**For release 1, default = the Hermes tech lead.** Record the name in
the release ticket. Solo-engineering case (one person builds + owns)
is fine — still write the name down so future-you knows the chain of
custody started with present-you.

---

## 12. Hermes Agent integration (MCP server + companion skill)

Hermes operators install this by adding two blocks to their
`~/.hermes/config.yaml` and restarting Hermes — there is no command in
the official `hermes mcp install` catalog flow because we are not going
through Hermes' catalog review for this server. The MCP server config is
just a `mcp_servers:` block like any user-side MCP integration.

The integration uses two of Hermes' four extension surfaces, picked off
the "Footprint Ladder" in [`hermes-agent/AGENTS.md`](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md):

| Hermes surface | What we ship | Where |
|---|---|---|
| **MCP server** (rung 5) | A Streamable HTTP MCP server bundled into the launcher, mounted on `/mcp`. Exposes four tools: `start_coding_task`, `get_session_status`, `send_followup_prompt`, `abort_session`. | `src/mcp/server.ts` |
| **Skill** (rung 2 companion) | A single `SKILL.md` teaching Hermes when to call the tools and how to render their results. Hardline-validated against Hermes' `_validate_frontmatter` and the seven skill-authoring rules. | `skills/hermes-control-plane/SKILL.md` |

We deliberately do NOT ship:

- A Hermes **plugin** (rung 4). Plugins are in-process Python; wrapping
  an external HTTP service in Python adds layers without changing the
  effect.
- A new **core tool** (rung 6). Core tools are paid for on every API
  call by every Hermes user — forbidden for non-fundamental capabilities.

### 12.1 Topology

```
Hermes Agent (Python)
    │
    │ MCP client (built-in, ~/.hermes/config.yaml mcp_servers:)
    ▼
Bun.serve :8789 /mcp          ← MCP Streamable HTTP transport
    │ in-process
    ▼
control-plane-launcher routes        ← POST /sessions, DELETE /sessions/:id, ...
    │
    ▼ HTTP → Cloudflare Worker
SessionDurableObject          ← state, event log, runner WS
    │
    ▼ E2B SDK
sandbox + opencode + runner
```

Both the launcher's HTTP API and its MCP server share one port. A single
Cloudflare Tunnel exposes both surfaces when Hermes runs off-host.

### 12.2 Tool surface

| MCP tool | Wraps | Hermes-side use |
|---|---|---|
| `start_coding_task` | `POST /sessions` (launcher) | Primary entry; called when the user describes a code change against a GitHub repo. |
| `get_session_status` | `GET /sessions/:id` (Worker) | Polling fallback when the host can't hold the WS stream open. |
| `send_followup_prompt` | `POST /sessions/:id/prompt` (Worker) | Mid-session follow-ups; auto-resumes paused sandboxes. |
| `abort_session` | `DELETE /sessions/:id` (launcher) | User cancellation; tears down sandbox + DO. |

Hermes' MCP client auto-discovers tools at startup via `tools/list`. No
schema duplication — the canonical schema lives in the MCP server
(`src/mcp/server.ts`) and is generated from Zod at runtime.

### 12.3 SKILL.md companion

`skills/hermes-control-plane/SKILL.md` is the prose layer telling
Hermes:

- **When to use** the tools (concrete code change against a GitHub repo,
  bounded scope, real PR wanted).
- **When NOT to use** them (questions, explanations, local-only repos).
- **Prerequisites** (MCP server registered, `GITHUB_USER_TOKEN` in
  launcher env).
- **Procedure** (5 ordered steps with completion criteria per the
  Hermes authoring HARDLINE §5).
- **Pitfalls** (don't shell out to `gh`/`git`, don't auto-merge, one
  sandbox per session, 429 means cap reached).
- **Verification** (post-run GitHub check that PR author = real user).

The skill is hardline-validated against Hermes' own validator:

```bash
# in this repo
python3 scripts/validate-skill.py skills/hermes-control-plane/SKILL.md
```

(see §12.5).

### 12.4 Install

Three edits, no Hermes PR:

```yaml
# ~/.hermes/config.yaml

mcp_servers:
  hermes-control-plane:
    url: "http://localhost:8789/mcp"       # same-host VPS
    # url: "https://launcher.<your-domain>/mcp"   # off-host via Tunnel
    timeout: 300

skills:
  external_dirs:
    - /opt/hermes-control-plane/src/skills               # where install.sh cloned the repo
```

Restart Hermes (`exit` + `hermes` for CLI, or `systemctl restart hermes`
for the gateway). The four tools and the skill appear automatically.

Full runbook: [`infra/mcp/README.md`](../infra/mcp/README.md).

### 12.5 What we DON'T put in the skill

Per Hermes' "What goes in skills vs. what stays in Hermes":

| Concern | Lives where |
|---|---|
| MCP tool schemas + HTTP shapes | MCP server (`src/mcp/server.ts`) |
| When to call `start_coding_task` vs. answer directly | SKILL.md `## When to Use` |
| How to render `pr.created` in Slack/Telegram/Discord | Hermes' platform adapters (their concern) |
| Which repos a user may touch | Hermes allow-list (their concern) |
| OAuth preconditions (`GITHUB_USER_TOKEN` set) | SKILL.md `## Prerequisites` |

Rule of thumb: **anything the control plane mandates → SKILL.md or MCP
schema. Anything Hermes chooses → Hermes config / adapter.**

### 12.6 Versioning

The MCP server and the SKILL.md are versioned independently:

- MCP server `serverInfo.version` in `src/mcp/server.ts` (bumped on tool
  add/remove/rename).
- SKILL.md `version:` field (bumped on prose changes that change agent
  behavior).

A breaking MCP tool change (rename / required-arg add) requires
bumping the server major and updating the skill in the same PR.


---

## 13. Concrete deploy steps (Worker + Launcher)

Two long-running components: the **Worker** on Cloudflare and the
**launcher** on any always-on host with public egress.

### 13.1 Worker (Cloudflare)

Durable Object Storage is the only persistent store (no D1/R2). Set
secrets, then deploy:

```bash
# One-off: log into Cloudflare
wrangler login

# Secrets (use `wrangler secret put` — do NOT commit them to wrangler.jsonc)
wrangler secret put E2B_API_KEY              # required; Worker refuses to provision otherwise
wrangler secret put PUBLIC_BASE_URL          # https://hermes.<your-domain>.workers.dev
wrangler secret put CONTROL_PLANE_LAUNCHER_URL      # https://<your-launcher-host>:8789 (Cloudflare Tunnel URL of the launcher VPS)
wrangler secret put GITHUB_WEBHOOK_SECRET    # required for PR-lifecycle + auto-amend webhooks (see §13.3)
# Optional — auto-amend cap per PR (default 3). Set as a plain var, not a secret.
# wrangler.jsonc → vars.HERMES_AUTOFIX_CAP = "5"

bun run deploy
```

Cloudflare will print the deployed Worker URL. Set that as
`PUBLIC_BASE_URL` (the runner inside the sandbox dials this over WSS —
no more ngrok needed in prod).

### 13.2 Launcher (any always-on host)

The launcher cannot run on Workers (workerd kills the E2B SDK). Run it
on a tiny VPS, Fly.io machine, Railway service, or your own box.
Required process env:

```bash
# E2B
export E2B_API_KEY=e2b_...
export E2B_TEMPLATE=control-plane-runner

# Model (Z.AI / OpenCode provider)
export ZAI_API_KEY=...

# GitHub single-user OAuth — PR author = real user (P1.1)
export GITHUB_USER_TOKEN=github_pat_...     # fine-grained PAT, see SETUP §5
export GITHUB_USER_LOGIN=your-github-handle
export GITHUB_USER_EMAIL=you@example.com

# Wire to the deployed Worker (one URL serves both launcher→Worker calls
# and the runner-inside-sandbox WS dial-back)
export CONTROL_PLANE_BASE_URL=https://hermes.<your-domain>.workers.dev

# Optional
export CONTROL_PLANE_LAUNCHER_PORT=8789
export MAX_CONCURRENT_SESSIONS=10
export CONTROL_PLANE_AUTO_PR=1

bun run launcher
```

Run it under a process supervisor (systemd, pm2, the platform's
restart policy). On boot it runs the orphan sweep, so a crash +
restart is safe. The canonical `infra/launcher/install.sh` +
`env.example` cover the systemd path.

### 13.3 GitHub webhook (PR lifecycle)

Hermes consumes one GitHub webhook event so the control plane knows
when a Hermes-opened PR is **merged** or **closed**. The session
transitions to `archived` (on merge) and the PR row is dropped from
the global PR index DO.

> **Why a webhook at all?** Without it, Hermes only knows the PR exists
> and never gets a signal that it merged — so `send_followup_prompt`
> against a merged PR cannot fail-closed, the event log misses
> `pr.merged`/`pr.closed`, and the PR index grows monotonically. The
> webhook is the only mechanism that closes the PR lifecycle loop.

**Scope** (locked in PR #24 + #25):

| Event | Why |
|---|---|
| `Pull requests` | merged/closed lifecycle (transition session to archived) |
| `Pull request reviews` | reviewer "Request changes" auto-spawns an amend session |
| `Check runs` | CI conclusion `failure` / `timed_out` auto-spawns an amend session |

Auto-amend has hard limits:
- Cap of **3** amend sessions per PR (override via `HERMES_AUTOFIX_CAP`)
- Strict single-flight per PR — concurrent triggers wait for the
  in-flight amend to finish (no queue; the rejected trigger ack 200)
- Dedup by `head_sha` — webhook retries with the same sha are no-op
- Self-review (reviewer == operator) is refused

Manual follow-up that isn't review/CI driven goes through the MCP
gateway (`send_followup_prompt`).

**Setup (per repository or per organization):**

1. In the GitHub repo / org settings → **Webhooks → Add webhook**.
2. **Payload URL:** `https://hermes.<your-domain>.workers.dev/webhooks/github`
3. **Content type:** `application/json`
4. **Secret:** generate a long random string (e.g. `openssl rand -hex 32`).
   Save it; you will also pass it to the Worker.
5. **SSL verification:** Enable.
6. **Which events?** Select *"Let me select individual events"* and
   tick **Pull requests**, **Pull request reviews**, **Check runs**.
   (Untick the default "Pushes".)
7. **Active:** Enable.
8. On the Worker:
   ```bash
   echo "<paste-the-secret>" | wrangler secret put GITHUB_WEBHOOK_SECRET
   ```

That's it. The Worker verifies `X-Hub-Signature-256` against the
secret, parses the payload, looks up the PR in the global PR index DO
(populated when Hermes opened the PR), and dispatches the lifecycle
transition into the relevant session.

**What the Worker does NOT need:**
- A GitHub App or OAuth client — webhooks are repo-scoped and don't
  require app installation.
- An incoming firewall exception — GitHub originates the call to your
  workers.dev domain; no inbound port on the launcher.

**Local testing.** Use `gh webhook forward` against a `wrangler dev`
instance. Set `GITHUB_WEBHOOK_SECRET` in `.dev.vars`. See
`tests/github-webhook.test.ts` for the on-the-wire shape of the events
we accept. For end-to-end live testing without GitHub, sign synthetic
webhook bodies with `scripts/e2e-autoamend-live.ts`:

```bash
GITHUB_WEBHOOK_SECRET=… bun run scripts/e2e-autoamend-live.ts \
  --pr-key duckhoa-uit/lawn#11 \
  --pr-url https://github.com/duckhoa-uit/lawn/pull/11 \
  --case review|check_run|duplicate_sha|inflight|cap
```

**Live verification matrix** (PRs on `duckhoa-uit/lawn`, see PR #24 + #25):

| Scenario | Trigger | PR | Outcome |
|---|---|---|---|
| `pull_request.opened` → register in PR index | real GitHub | #4–11 | row created on the singleton PR_INDEX_DO |
| `pull_request.closed` (merged=false) | real GitHub | #6 | session log gets `pr.closed`; index `status` flips to `closed` |
| `pull_request.closed` (merged=true) | real GitHub | #7 | session transitions `completed → archived`; index row unregistered |
| `pull_request_review.submitted` (changes_requested) | real GitHub review by 2nd account | #8 | amend session spawned; commit pushed onto same PR; `pr.autofix.triggered { trigger: "review_changes_requested" }` |
| `check_run.completed` (failure) | real GitHub Actions on a marker-file workflow | #11 | amend session spawned; agent removed marker file; subsequent CI run **succeeded** |
| `duplicate_sha` guard | real GitHub redelivery | #8 | 2nd review on same head sha → 200 `duplicate_sha` |
| `inflight` guard | synthetic (back-to-back deliveries) | #10 | 2nd delivery while spawn in flight → 200 `inflight` |
| `cap_exceeded` guard | synthetic | #10 | after 3 amends, 4th refused with `cap_exceeded` |

---

## 14. Locking the deployed Worker behind Cloudflare Access

Zero code changes. ~10 minutes one-off setup. Free on the Cloudflare
Zero Trust free plan (up to 50 users — more than enough for solo use).

**The trick:** the Worker exposes two kinds of routes that need
different treatment:

| Route group | Who calls it | Protection |
|---|---|---|
| `POST /sessions`, `POST /sessions/:id/prompt`, `POST /sessions/:id/abort`, `POST /sessions/:id/approve`, `POST /sessions/:id/create-pr`, `DELETE /sessions/:id`, `GET /sessions/:id`, `WS /sessions/:id/stream` | You (browser, curl with `cf-access-token` cookie, Slack-via-Hermes later) | **Behind Access** — login required |
| `WS /sessions/:id/runner?token=<runnerToken>` | The runner inside the E2B sandbox | **Bypass Access** — already protected by the per-session `runnerToken` (verified in `src/worker/session-do.ts:248`); the sandbox has no browser/cookie to satisfy Access |
| `GET /health` | Uptime monitors, smoke tests | **Bypass Access** — public health check |

The two bypass paths are safe because:
- `/sessions/*/runner` is gated by a per-session, single-use, 32-byte
  runner token minted in the DO and dropped into the sandbox at
  provision time. Not knowing the token → 401 from the DO.
- `/health` returns a static OK string with no session info.

### 14.1 Setup steps

1. **Get a Cloudflare Zero Trust account** (free):
   - Cloudflare dashboard → **Zero Trust** in the left sidebar.
   - Pick a team name (e.g. `hermes-yourname`); this becomes
     `<team>.cloudflareaccess.com`.

2. **Add a login method** (Zero Trust → Settings → Authentication):
   - Add **One-time PIN** (email magic-link) — simplest. Or GitHub /
     Google SSO if you prefer.

3. **Create an Access application** (Zero Trust → Access →
   Applications → Add):
   - Type: **Self-hosted**.
   - Application name: `hermes-control-plane`.
   - Session duration: 24 h is fine.
   - Application domain: `hermes.<your-subdomain>.workers.dev`
     (or your custom domain).
   - Path: leave blank to cover the whole domain.

4. **Add bypass rules for runner WS + health** (same app, **Add a
   path** → repeat for each):
   - Path `/health`: policy **Bypass** (or **Service Auth** if you
     want fewer logs; Bypass is fine for `/health`).
   - Path `/sessions/*/runner`: policy **Bypass**. (Be explicit
     about the trailing `/runner` — bypassing all of `/sessions/*`
     would defeat the point.)

5. **Add the allow rule for everything else**:
   - Policy name: `allow me`.
   - Action: **Allow**.
   - Include rule: **Emails** → `your@email.example`. (Or
     **Identity provider group**, etc.)
   - Save.

6. **Verify**:
   - Open `https://hermes.<your-subdomain>.workers.dev/health` in a
     browser → static `{ ok: true }` (or whatever, no Access prompt).
   - Open `https://hermes.<your-subdomain>.workers.dev/sessions` →
     Access login page → after login, the route returns the usual
     405 (no GET handler). Confirms the auth wall works.
   - Run `bun run launch …` against the deployed launcher — the
     runner inside the sandbox connects fine via `/sessions/*/runner`,
     the e2e completes, a real PR opens.

### 14.2 Things Cloudflare Access does *not* fix

- **CORS `*` in `src/worker/index.ts`.** Access does not strip CORS
  headers from your Worker. If you ever build a browser frontend
  served from a different origin, restrict CORS to that origin
  explicitly. For a solo CLI/curl flow this is harmless.
- **Rate limiting.** Access stops anonymous traffic; it does not
  cap *your own* traffic. Set a Cloudflare WAF rate-limit rule on
  the same domain if you want a soft cap.
- **Slack integration.** When you ship the multi-user Slack path
  (`ROADMAP.md §14`), Slack's outbound calls won't have an Access
  cookie either. Either bypass the Hermes-agent IP range, or move
  off Access entirely and use the §14 OAuth gate.

### 14.3 Locking the launcher too (recommended)

The launcher is a Bun process on a public-ish host. Lock it the same
way:

- If on Fly.io / Railway / Render: use the platform's built-in
  private networking + IP allowlist; only the Worker needs to reach
  it (and the Worker calls it from Cloudflare-owned IPs).
- If on a plain VPS: bind the launcher to `127.0.0.1:8789` and front
  it with a Cloudflare Tunnel (free) into the same Zero Trust app.
  Add `/sessions/*/resume` as a Bypass path (the Worker DO calls
  this when resuming a paused sandbox — no human cookie either).
- If you're the only caller and the host is on a NAT'd home network:
  Tailscale + launcher binding to the Tailscale IP works too. Same
  net effect.

Either way, do **not** leave the launcher's `POST /sessions` open to
the internet — that's the single endpoint that can spawn a sandbox
under your E2B account.
