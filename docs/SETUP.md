# Hermes Control Plane — Setup Guide

This walks through everything needed for a real end-to-end session: agent
runs inside an E2B sandbox, opens a GitHub PR against your repo, sandbox is
torn down on completion.

The high-level architecture is in [`ARCHITECTURE.md`](ARCHITECTURE.md). The roadmap
for what's next is in [`ROADMAP.md`](ROADMAP.md).

## 1. Prerequisites

- bun 1.3+
- Node 22+ (only for `wrangler dev`'s nodejs_compat target)
- wrangler CLI: `npm i -g wrangler`
- ngrok (free tier is fine) — only for local dev so the runner inside the
  sandbox can dial back to your Worker
- accounts: Cloudflare (free), E2B (Hobby), Z.AI (GLM Coding Plan), GitHub

## 2. Install

```bash
bun install
bun run test         # full unit + integration suite, no external creds needed
bun run typecheck    # tsc --noEmit clean
```

`bun run dev` will boot the Cloudflare Worker on `localhost:8787`. Without
the launcher (next sections) you can hit `/health` and unit-test the API
surface, but you cannot run a real session.

## 3. E2B (Hobby tier, free)

1. Sign up at https://e2b.dev/dashboard (Hobby is $0/mo, $100 one-time
   credits, no card).
2. Create an API key, copy it.
3. Add to `.dev.vars` **and** export it for the launcher process:
   ```
   E2B_API_KEY=e2b_xxxxxxxxxxxxxxxxxxxx
   ```

### Build the sandbox template

Hermes uses one pre-baked E2B template, `control-plane-runner`, that bakes node, bun,
`opencode`, the supervisor and the runner into the snapshot. This is what
gives us ~700–1500 ms cold starts.

```bash
E2B_API_KEY=… bun run template:build
```

The build runs in E2B's CI and takes a few minutes the first time, ~30 s on
subsequent rebuilds (layer cache). On success the template id is written to
`infra/e2b/dist/template-id.txt`. The default alias is `control-plane-runner` — no
config change needed unless you rename it.

Rebuild whenever you change `src/runner/supervisor.ts`,
`src/runner/sandbox-runner.ts`, or want to bump `opencode-ai`.

Limits on Hobby (see [`ROADMAP.md §8.2`](ROADMAP.md)): 20 concurrent
sandboxes, 1 sandbox/sec creation, 1 h continuous runtime, 10 GB disk. The
launcher's `MAX_CONCURRENT_SESSIONS` (default 10) keeps headroom.

## 4. Z.AI LLM (OpenCode provider)

OpenCode talks to Z.AI's GLM Coding Plan via its native `zai-coding-plan`
provider (no custom `opencode.json` needed).

1. Sign up at https://z.ai (international: https://open.bigmodel.cn) for the
   GLM Coding Plan.
2. Create an API key, copy it.
3. Add to `.dev.vars`:
   ```
   ZAI_API_KEY=…
   ```

The launcher injects `ZAI_API_KEY` into the sandbox per session. The
runner-side supervisor (`src/runner/supervisor.ts`) then registers it
with opencode via `PUT /auth/zai-coding-plan` before the runner starts.
The runner picks the model from `OPENCODE_MODEL_ID` (default `glm-5.2`,
in `src/runner/sandbox-runner.ts`).

Available models: `glm-5.2` (1M ctx, default), `glm-5.1` (200K), `glm-4.7`
(200K), `glm-4.5-air` (fast/cheap). To override at session level, pass
`OPENCODE_MODEL_ID` into the sandbox via the launcher's `start.json` (not
wired into a launcher env var yet — drop it manually in
`src/launcher/provision.ts:startConfig` if you need it before that lands).

## 5. GitHub PAT (for PR creation)

PRs are pushed and opened as the **real user** via a fine-grained personal
access token (P1.1). The runner uses it for `git push` and `POST /pulls`,
and the commit author is set from `GITHUB_USER_LOGIN`/`GITHUB_USER_EMAIL`.
That way branch-protection rules like "PR must be reviewed by someone
other than the author" work correctly.

1. Create a fine-grained PAT at https://github.com/settings/tokens?type=beta
   - Resource owner: your user (or org).
   - Repository access: select the repos Hermes touches.
   - Repository permissions: **Contents: Read & write**,
     **Pull requests: Read & write**. Leave everything else as No access.
   - Expiration: 90 days (rotate quarterly).
2. Export the PAT plus your identity:
   ```bash
   export GITHUB_USER_TOKEN=github_pat_xxx
   export GITHUB_USER_LOGIN=your-github-handle
   export GITHUB_USER_EMAIL=you@example.com   # optional; defaults to
                                              # <login>@users.noreply.github.com
   ```
3. Make sure GitHub has signed-commit / fork-permission settings that
   allow your PAT to push to the target repos.

## 5b. GitHub webhook (PR lifecycle + auto-amend)

Hermes consumes 3 GitHub event types per repository it touches:

| Event | What Hermes does |
|---|---|
| `Pull requests` | merged → archive session + drop the PR index row; closed → mark index `closed`. |
| `Pull request reviews` | reviewer "Request changes" → spawn an amend session that pushes a follow-up commit onto the same PR (no new PR). |
| `Check runs` | conclusion `failure` / `timed_out` → spawn an amend session to fix the CI failure. |

Auto-amend has hard limits per PR (locked in PR #24+#25):
- Cap of **3** amend sessions (`HERMES_AUTOFIX_CAP` env override on the Worker).
- Strict single-flight (concurrent triggers refused with `reason: "inflight"`).
- Dedup by head `sha` (webhook retries on the same sha are no-op).
- Self-review (reviewer == PR author) refused.

**Setup (per repo or per org):**

1. Sinh secret:
   ```bash
   openssl rand -hex 32
   ```
2. Set it on the Worker:
   ```bash
   echo "<secret>" | bunx wrangler secret put GITHUB_WEBHOOK_SECRET
   # local dev: put GITHUB_WEBHOOK_SECRET=… in .dev.vars
   ```
3. GitHub repo settings → **Webhooks → Add webhook**:
   - **Payload URL:** `https://<your-worker>.workers.dev/webhooks/github`
   - **Content type:** `application/json`
   - **Secret:** paste the same value
   - **SSL verification:** Enable
   - **Events:** select *"Let me select individual events"*, tick **Pull requests**, **Pull request reviews**, **Check runs**. Untick the default *Pushes*.
4. Save. GitHub sends a `ping` immediately — verify response is `200 OK`
   with `{"ok":true,"kind":"ignored","reason":"ping"}` under **Recent Deliveries**.

## 6. Public URL for the runner (ngrok in dev)

The runner inside the sandbox dials your Worker over WebSocket, and
the launcher calls the same Worker over HTTPS. Locally that needs one
public URL — `CONTROL_PLANE_BASE_URL`.

```bash
ngrok http 8787
# copy the https URL, e.g. https://abcd-1234.ngrok-free.app
export CONTROL_PLANE_BASE_URL=https://abcd-1234.ngrok-free.app
```

Free-tier ngrok is fine; the browser interstitial doesn't affect WS
upgrades. In production point `CONTROL_PLANE_BASE_URL` at the deployed Worker
URL — no tunnel needed.

## 7. `.dev.vars` example

For the Worker (read by `wrangler dev` automatically):

```
# E2B (only used by the launcher; Worker doesn't call E2B directly)
E2B_API_KEY=e2b_xxxxxxxxxxxxxxxxxxxx

# Z.AI (forwarded into the sandbox by the launcher)
ZAI_API_KEY=…

# GitHub single-user OAuth (P1.1): PR authored by the real user
GITHUB_USER_TOKEN=github_pat_xxx
GITHUB_USER_LOGIN=your-github-handle
GITHUB_USER_EMAIL=you@example.com
```

The launcher reads its own env from the shell that starts it, not from
`.dev.vars`. Easiest: put the same vars in a `.envrc` for direnv, or paste
them inline when launching.

**Worker env (set in `.dev.vars` for `wrangler dev`, or `wrangler secret put` for deploy):**

| Var | Purpose |
|---|---|
| `HEARTBEAT_TIMEOUT_MS` | runner stall threshold; default 15 min (see `src/core/constants.ts`) |
| `MAX_CONCURRENT_SESSIONS` | Hobby-tier headroom; default 10 (E2B Hobby cap is 20) |
| `PUBLIC_BASE_URL` | optional; falls back to the request origin |
| `CONTROL_PLANE_LAUNCHER_URL` | required for the M5 resume path; DO POSTs here to thaw paused sandboxes |
| `E2B_TEMPLATE` | template alias; defaults to `control-plane-runner` |
| `E2B_API_KEY` | the Worker doesn't call E2B, but refuses to provision when unset |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for `POST /webhooks/github`; required to ingest PR lifecycle / auto-amend events |
| `HERMES_AUTOFIX_CAP` | optional; max auto-amend sessions per PR (default `3`) |
| `CONTROL_PLANE_LAUNCHER_URL` | required when GITHUB_WEBHOOK_SECRET is set — Worker POSTs to launcher /sessions to spawn amend sessions. In local dev set to an ngrok URL pointing at the launcher (`:8789`). |

**Launcher env (process env, see `infra/launcher/env.example`):**

| Var | Purpose |
|---|---|
| `E2B_API_KEY` | required |
| `E2B_TEMPLATE` | default `control-plane-runner` |
| `CONTROL_PLANE_BASE_URL` | required; deployed Worker URL (or ngrok in dev). Used both for launcher→Worker and as the runner's WS dial-back URL. |
| `CONTROL_PLANE_LAUNCHER_PORT` | default `8789` |
| `CONTROL_PLANE_AUTO_PR` | `1` (default) = launcher fires `/create-pr` on `review_ready` |
| `ZAI_API_KEY` | OpenCode (Z.AI) provider key |
| `GITHUB_USER_TOKEN` / `GITHUB_USER_LOGIN` / `GITHUB_USER_EMAIL` | per-user PR identity |
| `MAX_CONCURRENT_SESSIONS` | default 10; E2B Hobby caps at 20 |

## 8. Run end-to-end (three terminals)

```bash
# Terminal 1 — Cloudflare Worker
bun run dev
# Ready on http://localhost:8787

# Terminal 2 — public URL for the runner to dial
ngrok http 8787
# https://abcd-1234.ngrok-free.app
```

```bash
# Terminal 3 — launcher (sidecar)
export E2B_API_KEY=… ZAI_API_KEY=…
export GITHUB_USER_TOKEN=… GITHUB_USER_LOGIN=…
# Use the ngrok URL for both launcher→Worker and runner→Worker.
export CONTROL_PLANE_BASE_URL=https://abcd-1234.ngrok-free.app
export E2B_TEMPLATE=control-plane-runner
bun run launcher
# [launcher] startup sweep: scanned=0 killed=0 kept=0
# [launcher] control-plane-launcher listening on http://localhost:8789
```

Trigger a session:

```bash
curl -X POST http://localhost:8789/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "taskDescription": "Add a top-of-file comment to README.md describing this repo",
    "repoUrl": "https://github.com/you/your-repo"
  }'
# { "sessionId": "…", "sandboxId": "…", "streamUrl": "…", "stateUrl": "…" }
```

Watch the events (in another shell):

```bash
SID=<sessionId>
watch -n 2 "curl -s http://localhost:8787/sessions/$SID | jq '{status: .session.status, prUrl: .artifacts.prUrl, events: (.events|length)}'"
```

On success: status reaches `completed` in ~30–60 s, `artifacts.prUrl` is a
real GitHub PR, the sandbox is auto-killed.

## 9. CLI (optional convenience)

`scripts/launch-session.ts` is a thin client. Two modes:

- **Sidecar mode** (preferred): set `CONTROL_PLANE_LAUNCHER_URL=http://localhost:8789`
  and just call:
  ```bash
  CONTROL_PLANE_LAUNCHER_URL=http://localhost:8789 \
  bun run launch https://github.com/you/repo "your task"
  ```
- **Direct mode** (no sidecar running): same vars as the launcher, no
  `CONTROL_PLANE_LAUNCHER_URL`. The CLI provisions the sandbox in-process and reaps
  it on exit.

## 10. Deployment (single-user, production)

This section moved to [`DEPLOYMENT.md`](./DEPLOYMENT.md):

- Worker deploy steps → [`DEPLOYMENT.md §13.1`](./DEPLOYMENT.md#131-worker-cloudflare).
- Launcher install + env → [`DEPLOYMENT.md §13.2`](./DEPLOYMENT.md#132-launcher-any-always-on-host).
- Token rotation cadence → [`DEPLOYMENT.md §4.4`](./DEPLOYMENT.md#44-secrets).
- "Single-user only — do not publish the Worker URL" → [`DEPLOYMENT.md §10`](./DEPLOYMENT.md#10-what-we-are-deliberately-not-doing-in-release-1).
- Locking the Worker behind Cloudflare Access → [`DEPLOYMENT.md §14`](./DEPLOYMENT.md#14-locking-the-deployed-worker-behind-cloudflare-access).

This SETUP file now focuses purely on local development. Continue to
[`DEPLOYMENT.md`](./DEPLOYMENT.md) when you're ready to ship.

## 11. Verification checklist

| Step | Command | Pass criterion |
|---|---|---|
| Unit + integration tests | `bun run test` | all tests pass (incl. the in-process DO E2E in `tests/e2e-do.test.ts`, webhook parser tests, MCP follow-up tests, PR index single-flight tests) |
| Typecheck | `bun run typecheck` | no output |
| Real-workerd E2E | start `bunx wrangler dev`, then `bun run e2e:real` | exits 0; `0 failed` in the summary |
| Full-system E2E (optional, costs LLM credits) | launcher + Worker + ngrok up, then `bun run e2e:full --repo https://github.com/<you>/<repo>` | session reaches `completed`; real PR opened |
| Worker boots | `bun run dev` then `curl http://localhost:8787/health` | `200 OK` |
| Template build | `bun run template:build` | `template id written to …` |
| Launcher boots | `bun run launcher` then `curl http://localhost:8789/health` | `{"status":"ok",...,"activeSessions":0}` |
| Orphan sweeper | restart launcher; existing tagged sandboxes whose sessions are terminal die | sweep log `scanned=N killed=N kept=0` |
| Full e2e | `POST /sessions` on launcher | session reaches `completed`; real PR opened; E2B list empty after |
| **P1.1 PR author** | `gh pr view <N> --json author` on the resulting PR | `author.login == $GITHUB_USER_LOGIN` and `author.is_bot == false` |
| **Webhook ping ack** | repo → Webhooks → click your hook → tab **Recent Deliveries** → look at the ping | response `200 OK`, body `{"ok":true,"kind":"ignored","reason":"ping"}` |
| **Webhook lifecycle** | open a PR via Hermes, merge it on GitHub | within ~10 s, parent session reaches `archived`; `GET /pr-index?key=owner/repo#N` returns 404 |
| **Webhook auto-amend (review)** | submit a `REQUEST_CHANGES` review on an open Hermes PR from a different account | within ~30 s, a 2nd commit lands on the same PR; parent session event log has `pr.autofix.triggered { trigger: "review_changes_requested" }` |
| | **Access — auth wall** (prod only) | open `https://<worker>/sessions` in a private browser window | Cloudflare Access login page appears (not a 405/200) |
| **Access — runner bypass** (prod only) | run an e2e session against the deployed launcher | runner connects, session reaches `completed`, real PR opens — proves `/sessions/*/runner` was *not* gated |
| **Access — health bypass** (prod only) | `curl https://<worker>/health` with no cookie | 200 OK, no Access redirect |
