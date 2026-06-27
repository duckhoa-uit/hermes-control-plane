# Error tracking (Sentry)

## What's wired up

The Worker is wrapped with [`@sentry/cloudflare`](https://docs.sentry.io/platforms/javascript/guides/cloudflare/) via [`src/core/error-tracking.ts`](../src/core/error-tracking.ts). The wrapper is a passthrough when `SENTRY_DSN` is unset, so forks / local dev / CI tests pay zero overhead.

What flows into Sentry:

| Source | What | Tags attached |
|---|---|---|
| Unhandled exceptions in `fetch()` | Full stack trace + breadcrumbs | (SDK defaults) |
| Explicit `captureError(err, ctx)` | Caller-tagged errors from the request-failed path | `request_id`, `path`, `method`, `status`, optional `session_id` |
| Source maps | Symbolicates the stack against TS source | (uploaded out-of-band) |

What does **not** flow in:

- **Secrets**. `redactString` from [`src/core/logger.ts`](../src/core/logger.ts) runs against every string field on the event before send (PATs, Bearer headers, long hex blobs, the project-specific `E2B_*` / `FF_*` patterns). Same redaction set as the structured logger; defense in depth.

## Operator setup

```bash
gh secret set SENTRY_DSN --body 'https://...@sentry.io/...'
gh secret set SENTRY_ENVIRONMENT --body 'production'  # optional, defaults to 'production'
# SENTRY_RELEASE is set by deploy-worker.yml to the git sha — no manual step.
```

For local dev: drop `SENTRY_DSN=...` into `.dev.vars` and `wrangler dev` will pick it up.

## Error → insight pipeline

[`.github/workflows/sentry-issue.yml`](../.github/workflows/sentry-issue.yml) consumes a Sentry webhook (delivered as a GitHub `repository_dispatch` of type `sentry-issue`) and opens or updates a GitHub issue. Idempotent via a `sentry:<issueId>` label so a recurring error doesn't spam the issue list.

One-time wiring per Sentry project (commented at the top of the workflow):

1. Sentry → Settings → Integrations → Internal Integration → "New".
2. Permissions: `Issue:Read`, `Event:Read`.
3. Add a webhook handler. URL = `https://api.github.com/repos/<owner>/<repo>/dispatches`. Auth = a fine-grained PAT with `Contents:write` + `Issues:write`. Payload uses Sentry's mustache vars (`{{ data.issue.id }}`, …) mapped to a `repository_dispatch` `event_type: sentry-issue` with the issue metadata as `client_payload`.

The workflow can also be triggered manually via `workflow_dispatch` for testing — mirrors the same payload shape.

## Why Sentry, not just our logger?

The structured logger (`src/core/logger.ts`) already writes NDJSON with redaction and request-id propagation. Sentry adds three things the logger doesn't:

1. **Aggregation** — groups identical errors so a 10k-occurrence outage shows as one issue, not 10k log lines.
2. **Source maps** — the stack trace points to the original TS line.
3. **Regression detection** — a new occurrence after a resolved issue reopens it automatically. This is what makes the GitHub-issue pipeline above tractable: one issue per error class, not one per occurrence.

The two sinks are complementary, not redundant. NDJSON logs are the source of truth for grep + jq; Sentry is the on-call dashboard.
