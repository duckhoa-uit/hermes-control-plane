# Hermes Control Plane — Setup Guide

This walks through everything needed for a real end-to-end session: agent
runs inside an E2B sandbox, opens a GitHub PR against your repo, sandbox is
torn down on completion.

The high-level architecture is in [`README.md`](../README.md). The roadmap
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
bun run test         # 87 tests should pass, no external creds needed
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

Hermes uses one pre-baked E2B template, `hermes-runner`, that bakes node, bun,
`opencode`, the supervisor and the runner into the snapshot. This is what
gives us ~700–1500 ms cold starts.

```bash
E2B_API_KEY=… bun run template:build
```

The build runs in E2B's CI and takes a few minutes the first time, ~30 s on
subsequent rebuilds (layer cache). On success the template id is written to
`infra/e2b/dist/template-id.txt`. The default alias is `hermes-runner` — no
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
runner-side supervisor (src/runner/supervisor.ts) then registers it with
opencode via `PUT /auth/zai-coding-plan` before the runner starts. The
model id is sent in the prompt body, not via env.

Available models: `glm-5.2` (1M ctx, default), `glm-5.1` (200K), `glm-4.7`
(200K), `glm-4.5-air` (fast/cheap).

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

## 6. Public URL for the runner (ngrok in dev)

The runner inside the sandbox dials your Worker over WebSocket, and
the launcher calls the same Worker over HTTPS. Locally that needs one
public URL — `HERMES_CP_BASE_URL`.

```bash
ngrok http 8787
# copy the https URL, e.g. https://abcd-1234.ngrok-free.app
export HERMES_CP_BASE_URL=https://abcd-1234.ngrok-free.app
```

Free-tier ngrok is fine; the browser interstitial doesn't affect WS
upgrades. In production point `HERMES_CP_BASE_URL` at the deployed Worker
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
export HERMES_CP_BASE_URL=https://abcd-1234.ngrok-free.app
export E2B_TEMPLATE=hermes-runner
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

- **Sidecar mode** (preferred): set `HERMES_CP_LAUNCHER_URL=http://localhost:8789`
  and just call:
  ```bash
  HERMES_CP_LAUNCHER_URL=http://localhost:8789 \
  bun run launch https://github.com/you/repo "your task"
  ```
- **Direct mode** (no sidecar running): same vars as the launcher, no
  `HERMES_CP_LAUNCHER_URL`. The CLI provisions the sandbox in-process and reaps
  it on exit.

## 10. Deployment (single-user, production)

Two long-running components: the **Worker** on Cloudflare and the
**launcher** on any always-on host with public egress.

### 10.1 Worker (Cloudflare)

Durable Object Storage is the only persistent store (no D1/R2). Set
secrets, then deploy:

```bash
# One-off: log into Cloudflare
wrangler login

# Secrets (use `wrangler secret put` — do NOT commit them to wrangler.toml)
wrangler secret put E2B_API_KEY              # required; Worker refuses to provision otherwise
wrangler secret put PUBLIC_BASE_URL          # https://hermes.<your-domain>.workers.dev
wrangler secret put HERMES_CP_LAUNCHER_URL      # https://<your-launcher-host>:8789 (Cloudflare Tunnel URL of the launcher VPS)

bun run deploy
```

Cloudflare will print the deployed Worker URL. Set that as
`PUBLIC_BASE_URL` (the runner inside the sandbox dials this over WSS — no
more ngrok needed in prod).

### 10.2 Launcher (any always-on host)

The launcher cannot run on Workers (workerd kills the E2B SDK). Run it on
a tiny VPS, Fly.io machine, Railway service, or your own box. Required
process env:

```bash
# E2B
export E2B_API_KEY=e2b_...
export E2B_TEMPLATE=hermes-runner

# Model (Z.AI / OpenCode provider)
export ZAI_API_KEY=...

# GitHub single-user OAuth — PR author = real user (P1.1)
export GITHUB_USER_TOKEN=github_pat_...     # fine-grained PAT, see §5 sub-section
export GITHUB_USER_LOGIN=your-github-handle
export GITHUB_USER_EMAIL=you@example.com

# Wire to the deployed Worker (one URL serves both launcher→Worker calls
# and the runner-inside-sandbox WS dial-back)
export HERMES_CP_BASE_URL=https://hermes.<your-domain>.workers.dev

# Optional
export HERMES_CP_LAUNCHER_PORT=8789
export MAX_CONCURRENT_SESSIONS=10
export HERMES_CP_AUTO_PR=1

bun run launcher
```

Run it under a process supervisor (systemd, pm2, the platform's restart
policy). On boot it runs the orphan sweep, so a crash + restart is safe.

### 10.3 Token rotation

- **`GITHUB_USER_TOKEN`** (PAT): rotate every 90 days. Restart launcher to
  pick up the new value. In-flight sessions started with the old token
  finish on the old token (the token is captured in the sandbox env at
  provision time).
- **`E2B_API_KEY`, `ZAI_API_KEY`**: same pattern — replace env + restart
  launcher.

### 10.4 Single-user reminder

There is no authentication on the Worker's session-mutating routes. Do
**not** expose the deployed Worker URL publicly without a Cloudflare
Access policy or equivalent (Zero Trust, IP allowlist, basic auth via a
front-end Worker). A second operator hitting `POST /sessions` would push
under your `GITHUB_USER_TOKEN`. Multi-user auth (per-user OAuth storage,
per-route auth) is the locked design in
[`ROADMAP.md §14`](ROADMAP.md).

§10.5 is the concrete runbook for the recommended approach
(Cloudflare Access) for 1-user release.

### 10.5 Locking the deployed Worker behind Cloudflare Access

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

#### Setup steps

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

#### Things Cloudflare Access does *not* fix

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

#### Locking the launcher too (recommended)

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

## 11. Verification checklist

| Step | Command | Pass criterion |
|---|---|---|
| Unit + integration tests | `bun run test` | 87/87 |
| Typecheck | `bun run typecheck` | no output |
| Worker boots | `bun run dev` then `curl http://localhost:8787/health` | `200 OK` |
| Template build | `bun run template:build` | `template id written to …` |
| Launcher boots | `bun run launcher` then `curl http://localhost:8789/health` | `{"status":"ok",...,"activeSessions":0}` |
| Orphan sweeper | restart launcher; existing tagged sandboxes whose sessions are terminal die | sweep log `scanned=N killed=N kept=0` |
| Full e2e | `POST /sessions` on launcher | session reaches `completed`; real PR opened; E2B list empty after |
| **P1.1 PR author** | `gh pr view <N> --json author` on the resulting PR | `author.login == $GITHUB_USER_LOGIN` and `author.is_bot == false` |
| **Access — auth wall** (prod only) | open `https://<worker>/sessions` in a private browser window | Cloudflare Access login page appears (not a 405/200) |
| **Access — runner bypass** (prod only) | run an e2e session against the deployed launcher | runner connects, session reaches `completed`, real PR opens — proves `/sessions/*/runner` was *not* gated |
| **Access — health bypass** (prod only) | `curl https://<worker>/health` with no cookie | 200 OK, no Access redirect |
