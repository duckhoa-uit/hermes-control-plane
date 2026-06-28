# Deployment

One command deploy to Cloudflare Workers:

```bash
npx flue build --target cloudflare
npx wrangler deploy
```

## Secrets (wrangler secret put)

| Secret | Purpose |
|---|---|
| `GITHUB_WRITE_TOKEN` | Push branches + create PRs |
| `GITHUB_READ_TOKEN` | Clone repos |
| `GITHUB_WEBHOOK_SECRET` | HMAC verify GitHub webhooks |
| `ZAI_API_KEY` | LLM provider (z.ai) |

## Vars (wrangler.jsonc)

| Var | Default | Purpose |
|---|---|---|
| `LLM_MODEL` | `zai/glm-5.2` | Model name |
| `WORKER_URL` | localhost:8787 | Dev override |

## Prerequisites

- Cloudflare Workers Paid plan (for DO + Containers)
- wrangler CLI logged in
