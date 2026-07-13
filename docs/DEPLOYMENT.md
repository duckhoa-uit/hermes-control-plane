# Deployment

Control Plan deploys as one Cloudflare Worker. The existing Worker script is
intentionally named `hermes-control-plane`; keep that name for the first
production rollout so Durable Object state is preserved.

## Production configuration

### Secrets

Set these with `wrangler secret put`. Wrangler prompts for each value; do not
commit them or put them in `wrangler.jsonc`.

| Secret | Purpose |
|---|---|
| `GITHUB_WRITE_TOKEN` | Push branches + create PRs |
| `GITHUB_READ_TOKEN` | Clone repos |
| `GITHUB_WEBHOOK_SECRET` | HMAC verify GitHub webhooks |
| `ZAI_API_KEY` | LLM provider (z.ai) |
| `CONTROL_PLAN_MCP_TOKEN` | Bearer token for Hermes remote MCP |
| `CONTROL_PLAN_REPLAY_SECRET` | Replay URL capability signing secret |
| `CONTROL_PLAN_PROXY_SECRET` | Internal GitHub proxy capability signing secret |
| `CONTROL_PLAN_INTERNAL_SECRET` | Internal Flue dispatch capability signing secret |

```bash
export WORKER_NAME=hermes-control-plane

npx wrangler secret put GITHUB_WRITE_TOKEN --name "$WORKER_NAME"
npx wrangler secret put GITHUB_READ_TOKEN --name "$WORKER_NAME"
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

### Runtime vars

These are non-secret deployment inputs. Keep them in the shell/CI environment
and inject them with `--var`; do not hard-code a production URL or repository
list in the repository.

| Var | Default | Purpose |
|---|---|---|
| `LLM_MODEL` | `zai/glm-5.2` | Model name |
| `WORKER_URL` | unset | Public HTTPS Worker origin used by callbacks and replay links |
| `CONTROL_PLAN_ALLOWED_REPOSITORIES` | unset | Comma-separated repository allowlist; unset means fail-closed |
| `CONTROL_PLAN_ALLOWED_BASE_BRANCHES` | `main` | Comma-separated base-branch allowlist |
| `APPROVAL_MODE` | `manual` | Production GitHub-write approval mode |

## Prerequisites

- Cloudflare Workers Paid plan (for Durable Objects + Containers)
- Wrangler CLI logged in
- Production repository and base-branch allowlists decided
- Public HTTPS Worker URL available

## Deploy and verify

Set the runtime inputs for this deployment. Use the exact repositories and
branches that Hermes profiles are allowed to delegate.

```bash
export WORKER_NAME=hermes-control-plane
export WORKER_URL="https://<your-worker-domain>"
export CONTROL_PLAN_ALLOWED_REPOSITORIES="owner/repo-a,owner/repo-b"
export CONTROL_PLAN_ALLOWED_BASE_BRANCHES="main"

bun run typecheck
bun run test
bun run lint
npx flue build --target cloudflare
npx wrangler deploy --dry-run \
  --name "$WORKER_NAME" \
  --var "WORKER_URL:${WORKER_URL}" \
  --var "CONTROL_PLAN_ALLOWED_REPOSITORIES:${CONTROL_PLAN_ALLOWED_REPOSITORIES}" \
  --var "CONTROL_PLAN_ALLOWED_BASE_BRANCHES:${CONTROL_PLAN_ALLOWED_BASE_BRANCHES}"
```

Only after the dry run passes, deploy with the same vars:

```bash
npx wrangler deploy \
  --name "$WORKER_NAME" \
  --var "WORKER_URL:${WORKER_URL}" \
  --var "CONTROL_PLAN_ALLOWED_REPOSITORIES:${CONTROL_PLAN_ALLOWED_REPOSITORIES}" \
  --var "CONTROL_PLAN_ALLOWED_BASE_BRANCHES:${CONTROL_PLAN_ALLOWED_BASE_BRANCHES}"
```

After deployment, verify the public boundary before connecting Hermes:

```bash
curl -fsS "$WORKER_URL/health"
curl -i "$WORKER_URL/mcp"  # must return 401 without Authorization
```

Configure Hermes with the production `/mcp` URL and the dedicated
`CONTROL_PLAN_MCP_TOKEN`. Use the four-tool allowlist from
[`HERMES-AGENT-INTEGRATION.md`](./HERMES-AGENT-INTEGRATION.md); do not point
Hermes at the localhost URL.

Run one read-only task first, followed by a disposable-branch smoke test that
covers approval, denial, and idempotent PR reuse.

The release artifact pins `@flue/cli`, `@flue/runtime`, and `@flue/sdk` to
`1.0.0-beta.9`; do not deploy with a globally installed older Flue CLI. The
Sandbox image remains pinned to `0.12.3`.
