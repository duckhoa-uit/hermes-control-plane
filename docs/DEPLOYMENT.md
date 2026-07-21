# Deployment

Control Plan deploys as one Cloudflare Worker. The existing Worker script is
intentionally named `hermes-control-plane`; keep that name for the first
production rollout so Durable Object state is preserved.

## Production configuration

### Create and install the GitHub App

Create a GitHub App under the GitHub account that owns the repositories Hermes
will modify. It does not need a callback URL or webhook events for the current
Hermes-driven flow. Grant only:

- Repository metadata: read
- Repository contents: read/write
- Pull requests: read/write

Generate a private key, record the numeric App ID, and install the App on the
personal account. Select **All repositories** when every repository owned by
that account is in scope. An organization owner must install/approve the App
for organization repositories.

### Secrets

Set these with `wrangler secret put`. Wrangler prompts for each value; do not
commit them or put them in `wrangler.jsonc`.

| Secret | Purpose |
|---|---|
| `GITHUB_APP_ID` | Numeric GitHub App identifier |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key used to mint short-lived installation tokens |
| `GITHUB_WEBHOOK_SECRET` | HMAC verify GitHub webhooks |
| `ZAI_API_KEY` | LLM provider (z.ai) |
| `CONTROL_PLAN_MCP_TOKEN` | Bearer token for Hermes remote MCP |
| `CONTROL_PLAN_REPLAY_SECRET` | Replay URL capability signing secret |
| `CONTROL_PLAN_PROXY_SECRET` | Internal GitHub proxy capability signing secret |
| `CONTROL_PLAN_INTERNAL_SECRET` | Internal Flue dispatch capability signing secret |

```bash
export WORKER_NAME=hermes-control-plane

npx wrangler secret put GITHUB_APP_ID --name "$WORKER_NAME"
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --name "$WORKER_NAME"
npx wrangler secret put GITHUB_WEBHOOK_SECRET --name "$WORKER_NAME"
npx wrangler secret put ZAI_API_KEY --name "$WORKER_NAME"
npx wrangler secret put CONTROL_PLAN_MCP_TOKEN --name "$WORKER_NAME"
npx wrangler secret put CONTROL_PLAN_REPLAY_SECRET --name "$WORKER_NAME"
npx wrangler secret put CONTROL_PLAN_PROXY_SECRET --name "$WORKER_NAME"
npx wrangler secret put CONTROL_PLAN_INTERNAL_SECRET --name "$WORKER_NAME"
```

Verify names without printing secret values:

```bash
npx wrangler secret list --name "$WORKER_NAME"
```

The GitHub App installation is the repository authorization boundary. Install it
with **All repositories** on the personal account if every owned repository is
in scope; organization repositories still require that organization's approval.
Control Plan resolves the repository's default branch from GitHub when Hermes
omits `baseBranch` and verifies an explicitly supplied branch exists. No
repository or branch allowlist is deployed.

After the migration is verified, revoke the old fine-grained PATs and remove
their local copies from `.dev.vars`; the Worker no longer reads them.

If the old secrets still exist on the Worker, remove them after the first
successful App-backed smoke task:

```bash
npx wrangler secret delete GITHUB_READ_TOKEN --name "$WORKER_NAME"
npx wrangler secret delete GITHUB_WRITE_TOKEN --name "$WORKER_NAME"
```

### Runtime vars

These are non-secret deployment inputs. Keep them in the shell/CI environment
and inject them with `--var`; do not hard-code a production URL or repository
list in the Worker configuration. The GitHub Actions deploy workflow reads
`WORKER_URL` from a repository Actions variable and fails closed if it is
missing or if any required Worker secret is absent.

| Var | Default | Purpose |
|---|---|---|
| `LLM_MODEL` | `zai/glm-5.2` | Model name |
| `WORKER_URL` | unset | Public HTTPS Worker origin used by callbacks and replay links; production is `https://control-plan.khoa.lol` |
| `APPROVAL_MODE` | `policy` | `policy` auto-publishes task-branch commits and draft PRs; `manual` approves every publication; `off` is unsafe development-only mode |
| `CONTROL_PLAN_EXECUTION_MODE` | `workflow` | New MCP tasks use the finite Flue Workflow; set `agent` only for rollback/legacy compatibility |

## Prerequisites

- Cloudflare Workers Paid plan (for Durable Objects + Containers)
- Wrangler CLI logged in
- A GitHub App installed on the account/organizations whose repositories Hermes may delegate
- GitHub App permissions: Metadata read, Contents read/write, Pull requests read/write
- Public HTTPS Worker URL available

## Deploy and verify

Set the runtime inputs for this deployment. Hermes profiles may delegate any
repository covered by the GitHub App installation; `baseBranch` is optional and
is resolved/verified dynamically per repository.

```bash
export WORKER_NAME=hermes-control-plane
export WORKER_URL="https://control-plan.khoa.lol"

bun run typecheck
bun run test
bun run lint
npx flue build --target cloudflare
npx wrangler deploy --dry-run \
  --name "$WORKER_NAME" \
  --var "WORKER_URL:${WORKER_URL}"
```

Only after the dry run passes, deploy with the same vars:

```bash
npx wrangler deploy \
  --name "$WORKER_NAME" \
  --var "WORKER_URL:${WORKER_URL}"
```

For the automatic `main` deployment, configure the non-secret repository
variable once:

```bash
gh variable set WORKER_URL \
  --repo duckhoa-uit/hermes-control-plane \
  --body "https://control-plan.khoa.lol"
```

`wrangler.jsonc` declares `control-plan.khoa.lol` as a Cloudflare Custom
Domain. The first deploy with the logged-in account creates the hostname's DNS
record and certificate; verify it with `curl -fsS "$WORKER_URL/health"` after
the deployment.

The Workflow migration adds `FlueCodingTaskWorkflow` in migration `v6`. Keep
that migration in every subsequent deploy so existing task and workflow
Durable Objects are preserved.

After deployment, verify the public boundary before connecting Hermes:

```bash
curl -fsS "$WORKER_URL/health"
curl -i "$WORKER_URL/mcp"  # must return 401 without Authorization
```

Configure Hermes with the production `/mcp` URL and the dedicated
`CONTROL_PLAN_MCP_TOKEN`. Control Plan exposes the coding lifecycle plus
read-only specialist MCP surface in
[`HERMES-AGENT-INTEGRATION.md`](./HERMES-AGENT-INTEGRATION.md); do not point
Hermes at the localhost URL.

Run one read-only task first, followed by a disposable-branch smoke test that
covers a policy-mode draft publication, an exceptional approval/denial, and
idempotent PR reuse. To test the native approval path, call
`respond_coding_approval` from the connected Hermes gateway and confirm that
the gateway renders `elicitation/create`; do not treat the tool's `decision`
argument as approval.

The release artifact pins `@flue/cli`, `@flue/runtime`, and `@flue/sdk` to
`1.0.0-beta.9`; do not deploy with a globally installed older Flue CLI. The
Sandbox image remains pinned to `0.12.3`.
