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
- Supervisor in `setStartCmd`; runner exec'd on `/opt/hermes/start.json`.
- `opencode serve` baked into the snapshot — verified surviving
  pause/resume with the same PID and warm cache (`ROADMAP.md §11.8.B`).
- Author-attributed events (`author_user_id` on `session_events`, populated
  from the Slack user id; required for multi-user — §6.2).
- GitHub App for *repo metadata* + *push* via short-lived installation
  token; **per-user GitHub OAuth for PR authorship** (release blocker —
  §7.3 + ROADMAP P1.1).
- `% sessions → merged PR` as the only release-quality metric.

What we explicitly do **not** copy from Inspect at this stage:

- Per-repo image registry. We ship one `hermes-runner` template. Per-repo
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
               ▼                        │ hermes-launcher (Bun)     │
        Slack thread                    │  - E2B SDK + GH App key   │
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
| Launcher sidecar | Bun 1.3+ | Single VM (Fly Machine / Hetzner CX22 / Railway) | Holds E2B + GH App secrets; `workerd` cannot drive the E2B SDK (see `ROADMAP.md §9.2`). One process is fine for ≤ 10 concurrent sessions. |
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
| `dev` | `wrangler dev` + ngrok | local `bun run launcher` | `hermes-runner` Hobby | dev workspace, channel `#hermes-dev` |
| `staging` | `hermes-staging.workers.dev` | small VM | `hermes-runner-staging` Hobby | dev workspace, channel `#hermes-staging` |
| `prod` | `hermes.workers.dev` (or custom domain) | dedicated VM | `hermes-runner-prod` Hobby (Pro after §6.4) | prod workspace, channel chosen by team |

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
`HERMES_RELEASE` env var on both Worker and launcher). The template
inherits the tag in its alias: `hermes-runner-prod-v0.3.1`. This makes
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
  `systemctl restart hermes-launcher` with the env pointing at it.
- **E2B template**: aliases are immutable per-version. To roll back, set
  `E2B_TEMPLATE=hermes-runner-prod-v<prev>` in the launcher env. No
  rebuild needed.

The rollback target is **always the previous green release tag**, not
"latest minus one commit". This is enforced by the smoke gate.

### 4.4 Secrets

Lifted from `.dev.vars.example` and `wrangler.toml`. Owners and rotation
cadence:

| Secret | Where | Owner | Rotation | Notes |
|---|---|---|---|---|
| `E2B_API_KEY` | launcher VM env | infra | quarterly | rotate via E2B dashboard, hot-swap env, restart launcher |
| `ZAI_API_KEY` | launcher VM env | infra | quarterly | OpenCode reads `ZHIPU_API_KEY` inside the sandbox; launcher forwards |
| `GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY` (PKCS#8) | launcher VM env | infra | yearly or on suspicion | broker mints ≤ 1 h installation tokens per session — main credential is short-lived |
| `GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET` | Worker secret (`wrangler secret put`) | infra | yearly | OAuth app for per-user PR authorship (P1.1). Distinct from the GitHub *App* above. |
| `OAUTH_TOKEN_ENCRYPTION_KEY` (32-byte AES-256-GCM, base64) | Worker secret | infra | quarterly | encrypts per-user OAuth tokens at rest in DO storage. Rotation = decrypt-then-reencrypt sweep (script in `scripts/rotate-oauth-key.ts`). |
| `HERMES_PUBLIC_URL` | launcher VM env | infra | n/a | the Worker URL; static per env |
| Slack signing secret + bot token | Hermes agent infra | Hermes team | yearly | not in this repo |

Secrets that *do* live in the Worker (post-P1.1): the GitHub OAuth
client secret and the OAuth token encryption key. Everything else
(E2B, GH App, Z.AI) is launcher-only. The Worker is the right place
for OAuth secrets because the OAuth dance terminates there
(`/auth/github/callback`).

---

## 5. Operational guardrails (already in code, called out for release)

These are not new asks; they are the safety net the release relies on.
Listed so the on-caller knows what each one protects against.

| Guardrail | Where | Protects against |
|---|---|---|
| `MAX_CONCURRENT_SESSIONS=10` | `wrangler.toml` + launcher env | E2B Hobby cap exhaustion |
| Launcher hard deadline = 24 h | `src/launcher/server.ts:75` | runaway-job backstop (paused sandboxes are free and indefinite per §12.14, so this is purely a GC ceiling, not a follow-up window) |
| `HEARTBEAT_TIMEOUT_MS=60s` | `wrangler.toml` | runner stall (transitions to `stalled → failed`) |
| Orphan sweeper at boot | `src/launcher/sweeper.ts` | leaked sandboxes after launcher crash |
| 35-min force-kill | per-session watcher in `src/launcher/server.ts` | safety net above E2B's 15-min idle pause |
| Session-scoped runner token | minted in DO, dropped in `start.json` | broad-credential exposure inside the sandbox |
| GH installation token, repo-scoped, ≤ 1 h | `src/launcher/github-token.ts` | long-lived GH credentials inside the sandbox |
| Sandbox auto-pause on idle (15 min) | `Sandbox.create` lifecycle | wasted E2B compute |
| Per-session turn cap (proposed §8.4 ROADMAP, not yet implemented) | DO | runaway loops under full auto-allow |

Action for release: confirm the turn cap (`ROADMAP.md §8.4`) is
implemented or explicitly accept the risk in the release notes.

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
2. **User GitHub OAuth for PR creation (P1.1).** Replace the App-token
   PR-open path in the runner with a Worker-side handoff: runner emits
   `pr.ready` carrying branch + commits; Worker reads the OAuth token from
   DO storage (decrypted), calls `POST /repos/{owner}/{repo}/pulls` as the
   user, emits `pr.created`. The App installation token still does the
   `git push` (it's the only thing with write access via Hermes' GH App
   install). Authorship = real user; pusher = bot. GitHub's UI shows the
   user as PR author, which is what branch-protection's
   "no-self-approve" rule reads.
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

PRs are authored by the **real user** via OAuth (P1.1). The GitHub App
installation token only pushes the branch — it is not the PR author.
Concretely on GitHub:

- `pull_request.user.login` = the Slack user's GitHub login
- `pull_request.head` was pushed by the App (visible in commit "verified
  by" + push-event payload)
- Branch protection's "PR review by someone other than author" rule
  rejects self-approval because the author is a real user, not the bot

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

- [ ] `bun run test` → 87/87 (or current number) passing
- [ ] `bun run typecheck` → clean
- [ ] E2B template built and tagged with the release version
- [ ] `wrangler deploy --env <env>` → succeeds
- [ ] Launcher binary deployed; `curl https://launcher/<env>/health` → ok
- [ ] `scripts/release-smoke.ts` end-to-end → PR opened on the sentinel
      repo, sandbox killed, E2B list empty afterwards
- [ ] GH App installed on the target repos (push-only)
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

---

## 11. Decisions (closed open-questions)

These were marked as open in the original draft; resolved here so they
stop blocking the release ticket.

1. **Prod Slack channel** → the channel Hermes already lives in. No
   new channel created for release 1; reduces split-attention. If
   volume warrants splitting later, the channel id is a launcher env
   var (`HERMES_SLACK_DEFAULT_CHANNEL`), one-line change.
2. **Sentinel repo for `release-smoke.ts`** → a throwaway in the team
   GitHub org named `hermes-sentinel`. Public, README-only, branch
   protection off, single file `README.md`. Exercises the real GH App
   install path (the app must be installed on this repo too) — that
   coverage is exactly what we want before promoting to prod. A
   read-only test repo would miss the install-token mint code path.
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
- `GITHUB_PRIVATE_KEY` (PKCS#8) — issues installation tokens for any
  repo the GitHub App is installed on
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

## 12. Hermes skills (orchestration sugar)

Hermes' "intent → tool" mapping needs a tiny amount of shared vocabulary
between this repo (the contract) and the Hermes agent (the consumer).
Rather than ship that vocabulary as English in `§6.3` and hope it stays
in sync, we check it into a top-level `skills/` directory in **this**
repo. The Hermes agent loads it at boot.

### 12.1 Why here, not in the Hermes repo

- This repo owns the HTTP contract; the skill is the **machine-readable
  form** of the same contract. Keeping them in one place is the only
  way to prevent doc drift.
- Future clients (web UI, CLI, other agents) reuse the same skill files
  — they describe what the *control plane* exposes, not what Hermes
  decides to do with it.
- One PR touches one repo when the contract changes.

This is the same pattern OpenCode uses for its plugins (`opencode/`
plugin dir lives with the agent, not with the consumer), and what
OpenHands does with its action schemas.

### 12.2 Layout

```
skills/
  README.md                              # what this dir is, how Hermes loads it
  hermes-code-task/                      # the primary skill
    skill.json                           # tool-schema in JSON-Schema form
    prompt.md                            # system-prompt fragment Hermes injects
    examples.md                          # 3-5 worked examples for few-shot
  hermes-session-status/                 # /hermes status [sessionId] slash cmd
    skill.json
    prompt.md
  hermes-abort-task/                     # cancel an in-flight session
    skill.json
    prompt.md
```

Each skill is a directory because every skill has the same 3 files. A
new skill = `mkdir skills/<name>` + 3 files.

### 12.3 `skill.json` shape

Locked schema, so the Hermes loader can just `JSON.parse` and validate:

```json
{
  "name": "hermes-code-task",
  "version": "1.0.0",
  "description": "Run a background coding task in a sandbox and open a PR.",
  "trigger": {
    "intents": ["code_task", "fix_bug", "add_feature", "refactor"],
    "requires": ["repo_url", "task_description"]
  },
  "transport": {
    "kind": "http",
    "method": "POST",
    "url_env": "HERMES_LAUNCHER_URL",
    "path": "/sessions"
  },
  "input_schema": { "$ref": "../../docs/openapi.yaml#/components/schemas/CreateSessionRequest" },
  "output_schema": { "$ref": "../../docs/openapi.yaml#/components/schemas/CreateSessionResponse" },
  "stream": {
    "kind": "ws",
    "url_field": "streamUrl"
  },
  "preconditions": [
    {
      "check": "github_oauth_token",
      "on_fail": "respond_with_auth_link"
    }
  ]
}
```

`$ref` points at a single OpenAPI doc (`docs/openapi.yaml`, generated
from the Worker routes — added in the OAuth PR). One source of truth
for request/response shapes.

### 12.4 `prompt.md` shape

What Hermes inlines into its system prompt when this skill is loaded.
Kept short — Hermes is the one deciding when to use it, not us.

```markdown
## hermes-code-task

Use this skill when the user asks for a code change against a known
repo. You will get back a session id and a WS stream. Stream concise
updates (one Slack message per "phase": started, working, PR opened).
DO NOT post per-token deltas. If `POST /sessions` returns 412, the
user has not authenticated GitHub yet — post the `auth_url` from the
response body and stop. If it returns 429, the queue is full — apologise
and ask the user to retry in a minute.
```

### 12.5 Loader contract

Hermes side (out of this repo, but documented here so the contract is
explicit):

```ts
// pseudo-code on the Hermes agent
import { readdirSync, readFileSync } from "node:fs";
const SKILLS_DIR = process.env.HERMES_SKILLS_DIR ?? "./skills";
for (const name of readdirSync(SKILLS_DIR)) {
  const skill = JSON.parse(readFileSync(`${SKILLS_DIR}/${name}/skill.json`, "utf8"));
  const prompt = readFileSync(`${SKILLS_DIR}/${name}/prompt.md`, "utf8");
  hermes.registerTool(skill, prompt);
}
```

In dev, Hermes clones this repo and points `HERMES_SKILLS_DIR` at
`./hermes-control-plane/skills`. In prod, the launcher's deploy
artifact ships the `skills/` directory and Hermes mounts it via a
shared volume or a tiny `GET /skills.tar.gz` endpoint on the
launcher.

### 12.6 What goes in skills vs. what stays in Hermes

| Concern | Lives where |
|---|---|
| HTTP shape of `POST /sessions` | `skills/hermes-code-task/skill.json` (this repo) |
| When to call `code_task` vs. `chitchat` | Hermes intent router (Hermes repo) |
| How to render `agent.message.delta` in Slack Block Kit | Hermes Slack adapter (Hermes repo) |
| Which repos a user is allowed to touch | Hermes allow-list (Hermes repo) |
| OAuth preconditions (block call if no token) | `skills/hermes-code-task/skill.json` declares the precondition; Hermes enforces it |

Rule of thumb: **anything the control plane mandates → skill file in
this repo. Anything Hermes chooses → Hermes repo.**

### 12.7 Versioning

`skill.json#version` is independent of the repo version. Hermes pins
skills by SHA when it loads (logged at boot). Breaking changes bump
the major: `1.x → 2.0`; Hermes refuses to load a major it doesn't
support. Patch/minor changes load silently.
