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
bun run test         # 57 tests should pass, no external creds needed
bun run typecheck    # tsc --noEmit clean
bun run db:init      # local D1 schema
```

`bun run dev` will boot the Cloudflare Worker on `localhost:8788`. Without
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
   ZAI_MODEL=glm-5.2
   ```

The launcher injects two env vars into the sandbox per session:
- `ZHIPU_API_KEY` = `ZAI_API_KEY` (what OpenCode's provider reads)
- `OPENCODE_MODEL` = `zai-coding-plan/glm-5.2` (or whatever `ZAI_MODEL` is)

Available models: `glm-5.2` (1M ctx, default), `glm-5.1` (200K), `glm-4.7`
(200K), `glm-4.5-air` (fast/cheap).

## 5. GitHub App (for PR creation)

PRs are pushed and opened by a GitHub App, using short-lived (≤ 1 h),
repo-scoped installation tokens minted per session.

### Create the App

1. Go to:
   - personal: https://github.com/settings/apps/new
   - org: `https://github.com/organizations/<org>/settings/apps/new`
2. Fill in:
   - Name: `Hermes Control Plane` (must be globally unique)
   - Homepage URL: `http://localhost:8788`
3. **Webhook**: uncheck "Active". Leave URL/secret blank.
4. **Repository permissions**:

   | Permission | Value | Why |
   |---|---|---|
   | Administration | Read-only | list repos |
   | Contents | Read & write | clone, push branch |
   | Metadata | Read-only | auto-required |
   | Pull requests | Read & write | open the PR |
   | Commit statuses | Read-only | read CI status |
   | Actions | Read-only | read workflow runs (optional) |

   Leave everything else as **No access**.
5. **Where can this App be installed?** "Only on this account" for personal
   use.
6. Click **Create GitHub App**.
7. On the App settings page note **App ID** (numeric).
8. Scroll to **Private keys** → **Generate a private key**. A `.pem`
   downloads. Keep it safe — GitHub only gives it to you once.
9. Left sidebar → **Install App** → select the repos Hermes is allowed to
   touch → Install.

### Convert the key to PKCS#8

GitHub gives you a PKCS#1 key (`-----BEGIN RSA PRIVATE KEY-----`). The token
broker expects PKCS#8 (`-----BEGIN PRIVATE KEY-----`). Convert once:

```bash
openssl pkcs8 -topk8 -nocrypt \
  -in  hermes-control-plane.private-key.pem \
  -out hermes-control-plane.pkcs8.pem
```

Keep both files outside the repo.

### Configure the launcher

Two options. Either reference the file (recommended):

```bash
export GITHUB_APP_ID=123456
export GITHUB_PRIVATE_KEY_FILE=/abs/path/hermes-control-plane.pkcs8.pem
```

…or paste the PEM into `.dev.vars` (note: multi-line in `.dev.vars` works,
each subsequent line is treated as the continuation of the value):

```
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----
MIIEv…
…
-----END PRIVATE KEY-----
```

## 6. Public URL for the runner (ngrok in dev)

The runner inside the sandbox dials your Worker over WebSocket. Locally that
needs a public URL.

```bash
ngrok http 8788
# copy the https URL, e.g. https://abcd-1234.ngrok-free.app
export HERMES_PUBLIC_URL=https://abcd-1234.ngrok-free.app
```

Free-tier ngrok is fine; the browser interstitial doesn't affect WS
upgrades.

## 7. `.dev.vars` example

For the Worker (read by `wrangler dev` automatically):

```
# E2B (only used by the launcher; Worker doesn't call E2B directly)
E2B_API_KEY=e2b_xxxxxxxxxxxxxxxxxxxx

# Z.AI (forwarded into the sandbox by the launcher)
ZAI_API_KEY=…
ZAI_MODEL=glm-5.2

# GitHub App (broker is in src/launcher/github-token.ts, host-side only)
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----
…
-----END PRIVATE KEY-----
```

The launcher reads its own env from the shell that starts it, not from
`.dev.vars`. Easiest: put the same vars in a `.envrc` for direnv, or paste
them inline when launching.

## 8. Run end-to-end (three terminals)

```bash
# Terminal 1 — Cloudflare Worker
bun run dev
# Ready on http://localhost:8788

# Terminal 2 — public URL for the runner to dial
ngrok http 8788
# https://abcd-1234.ngrok-free.app
```

```bash
# Terminal 3 — launcher (sidecar)
export E2B_API_KEY=… ZAI_API_KEY=… ZAI_MODEL=glm-5.2
export GITHUB_APP_ID=… GITHUB_PRIVATE_KEY_FILE=/abs/path/...pkcs8.pem
export HERMES_BASE_URL=http://localhost:8788
export HERMES_PUBLIC_URL=https://abcd-1234.ngrok-free.app
export E2B_TEMPLATE=hermes-runner
bun run launcher
# [launcher] startup sweep: scanned=0 killed=0 kept=0
# [launcher] hermes-launcher listening on http://localhost:8789
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
watch -n 2 "curl -s http://localhost:8788/sessions/$SID | jq '{status: .session.status, prUrl: .artifacts.prUrl, events: (.events|length)}'"
```

On success: status reaches `completed` in ~30–60 s, `artifacts.prUrl` is a
real GitHub PR, the sandbox is auto-killed.

## 9. CLI (optional convenience)

`scripts/launch-session.ts` is a thin client. Two modes:

- **Sidecar mode** (preferred): set `HERMES_LAUNCHER_URL=http://localhost:8789`
  and just call:
  ```bash
  HERMES_LAUNCHER_URL=http://localhost:8789 \
  bun run launch https://github.com/you/repo "your task"
  ```
- **Direct mode** (no sidecar running): same vars as the launcher, no
  `HERMES_LAUNCHER_URL`. The CLI provisions the sandbox in-process and reaps
  it on exit.

## 10. Cloudflare deployment (when you're ready)

```bash
# DO Storage is the only persistent store (D1/R2 removed in §12.16).
# Just set Worker secrets and deploy.
wrangler secret put MAX_CONCURRENT_SESSIONS  # optional override

# Deploy
bun run deploy
```

Note: the deployed Worker URL replaces the ngrok tunnel. Point the
launcher's `HERMES_BASE_URL` and `HERMES_PUBLIC_URL` at it. The launcher
itself still has to run somewhere with internet egress and the E2B+GH App
credentials (see [`ROADMAP.md §10`](ROADMAP.md) for the deploy
follow-up).

## 11. Verification checklist

| Step | Command | Pass criterion |
|---|---|---|
| Unit + integration tests | `bun run test` | 57/57 |
| Typecheck | `bun run typecheck` | no output |
| Worker boots | `bun run dev` then `curl http://localhost:8788/health` | `{"status":"ok",...}` |
| Template build | `bun run template:build` | `template id written to …` |
| Launcher boots | `bun run launcher` then `curl http://localhost:8789/health` | `{"status":"ok",...,"activeSessions":0}` |
| Orphan sweeper | restart launcher; existing tagged sandboxes whose sessions are terminal die | sweep log `scanned=N killed=N kept=0` |
| Full e2e | `POST /sessions` on launcher | session reaches `completed`; real PR opened; E2B list empty after |
