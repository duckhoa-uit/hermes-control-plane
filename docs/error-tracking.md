# Error tracking + product analytics (PostHog)

## What's wired up

The Worker is wrapped with [`posthog-node`](https://posthog.com/docs/libraries/cloudflare-workers) via [`src/core/error-tracking.ts`](../src/core/error-tracking.ts). The wrapper is a passthrough when `POSTHOG_PROJECT_TOKEN` is unset, so forks / local dev / CI tests pay zero overhead.

What flows into PostHog:

| Source | What | Properties attached |
|---|---|---|
| Unhandled exceptions in `fetch()` | `$exception` event with full stack trace | `path`, `method` |
| Explicit `captureError(err, ctx, env)` | Caller-tagged errors from the request-failed path | `request_id`, `path`, `method`, `status`, optional `session_id` |
| Release tag | `POSTHOG_RELEASE` set by deploy CI to the git sha | (used for regression detection) |

What does **not** flow into PostHog:

- **Secrets**. `redactString` from [`src/core/logger.ts`](../src/core/logger.ts) runs against every string property on the event before send (GitHub PATs, Bearer headers, long hex blobs, project-specific `E2B_*` / `FF_*` patterns). Same redaction set as the structured logger; defense in depth.

## Why PostHog (and not Sentry)?

| Criterion | Sentry Free | PostHog Free |
|---|---|---|
| Errors / exceptions per month | 5K | **100K** |
| Projects | 1 | 1 (paid: 6) |
| Product analytics included | No | **Yes (1M events/month)** |
| Feature flags included | No | **Yes (1M requests/month)** |
| Self-host option | Yes (heavy) | Yes (MIT) |

For this repo, PostHog covers two Agent Readiness signals with one SDK: `error_tracking_contextualized` (exceptions with request_id) **and** `product_analytics_instrumentation` (the same client captures custom events for future agent-usage telemetry).

## Operator setup

```bash
# Sign up at https://app.posthog.com/signup (US region — change POSTHOG_HOST
# in wrangler.jsonc to https://eu.i.posthog.com if you pick EU).
# Project Settings -> Project API Key -> copy the public token.

gh secret set POSTHOG_PROJECT_TOKEN --body 'phc_...'
# POSTHOG_RELEASE is set by deploy-worker.yml to the git sha — no manual step.
# POSTHOG_HOST defaults to https://us.i.posthog.com via wrangler.jsonc vars.
```

For local dev: drop `POSTHOG_PROJECT_TOKEN=phc_...` into `.dev.vars` and `wrangler dev` will pick it up.

For the Worker runtime to receive the token at deploy time:

```bash
echo 'phc_...' | bunx wrangler secret put POSTHOG_PROJECT_TOKEN
```

## Error → insight pipeline

[`.github/workflows/posthog-issue.yml`](../.github/workflows/posthog-issue.yml) consumes a PostHog webhook (delivered as a GitHub `repository_dispatch` of type `posthog-issue`) and opens or updates a GitHub issue. Idempotent via a `posthog:<fingerprint>` label so a recurring error doesn't spam the issue list.

One-time wiring per PostHog project (commented at the top of the workflow):

1. PostHog → **Data pipelines → Destinations → New → Webhook**.
2. URL: `https://api.github.com/repos/<owner>/<repo>/dispatches`. Auth = a fine-grained PAT with `Contents:write` + `Issues:write`.
3. Headers (all four required):
   - `Authorization: token <fine-grained PAT>`
   - `Accept: application/vnd.github+json`
   - `Content-Type: application/json`
   - `User-Agent: posthog-webhook-hermes-control-plane`
     (any non-empty string works — GitHub returns **403 "Request forbidden by administrative rules"** if this header is missing, and PostHog does not set one by default).
4. PostHog destinations default to **Hog templating** (single curly braces `{ }`); the older Liquid syntax (`{{ }}`) is opt-in via the **Templating** dropdown on the destination form. The example below uses Hog:
   ```json
   {
     "event_type": "posthog-issue",
     "client_payload": {
       "issue_id": "{event.properties.$exception_fingerprint}",
       "title": "{event.properties.$exception_type}: {event.properties.$exception_message}",
       "url": "{event.url}",
       "level": "error",
       "culprit": "{event.properties.path} {event.properties.method}",
       "first_seen": "{event.timestamp}"
     }
   }
   ```
   (`{event.url}` is the canonical PostHog event URL — preferable to hand-building one from `<project_id>`.)
5. Filter: event = `$exception`. Throttle to first occurrence per fingerprint to avoid spamming.

The workflow can also be triggered manually via `workflow_dispatch` for testing — mirrors the same payload shape.

## Why PostHog on top of the structured logger?

The structured logger (`src/core/logger.ts`) already writes NDJSON with redaction and request-id propagation. PostHog adds three things the logger doesn't:

1. **Aggregation by fingerprint** — groups identical errors so a 10k-occurrence outage shows as one issue, not 10k log lines.
2. **Stack trace symbolication** — the stack trace points to the original TS line via source maps.
3. **Regression detection** — a new occurrence after a resolved issue reopens it automatically. This is what makes the GitHub-issue pipeline above tractable: one issue per error class, not one per occurrence.

The two sinks are complementary, not redundant. NDJSON logs are the source of truth for grep + jq; PostHog is the on-call dashboard.
