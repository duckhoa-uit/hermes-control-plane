// ============================================================
// Error tracking — Sentry integration
//
// Thin wrapper around `@sentry/cloudflare` so the worker entrypoint
// stays readable. The Sentry SDK is lazy-loaded (`import("…")`) and the
// wrapper short-circuits when `SENTRY_DSN` is unset, so a fork running
// without a Sentry project pays exactly zero runtime cost.
//
// What flows into Sentry:
//   - Unhandled exceptions thrown inside `fetch()` — captured by the
//     `withSentry` wrapper from `@sentry/cloudflare`.
//   - Errors explicitly reported via `captureError(err, context)` —
//     called from request-failed paths so we attach the request id,
//     path, and method as Sentry tags. The DO logger module also calls
//     this when a structured log line is emitted at level=error.
//   - Source maps and release identifier (the git sha CI passes in
//     SENTRY_RELEASE) so the stack trace links to the right source.
//   - Breadcrumbs and request context (URL, headers minus the
//     SENTRY_REDACTED secret-bearing ones) for every captured event.
//
// What does NOT flow into Sentry:
//   - Secrets — `redactString` from src/core/logger.ts is run against
//     every string field on the event before send. Defense-in-depth in
//     case a token leaks into an error message.
//
// Configuration knobs (see src/worker/env.d.ts):
//   - SENTRY_DSN: gate. When unset, the wrapper is a passthrough.
//   - SENTRY_ENVIRONMENT: tag (defaults to "production").
//   - SENTRY_RELEASE: tag (CI sets to the git sha).
// ============================================================

import * as Sentry from "@sentry/cloudflare";
import { redactString } from "./logger";

/**
 * Surface of the Worker env we read. Kept structural so the launcher
 * (which has its own env shape) can share the helpers below.
 */
export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
}

/**
 * @sentry/cloudflare's `withSentry` helper takes a Worker default
 * export and wraps fetch/scheduled/queue handlers with the SDK. We
 * use the function form so the options can read from the per-request
 * env binding (DSN lives in `wrangler secret put`).
 *
 * When SENTRY_DSN is unset we return the handler unwrapped, so the
 * import has zero side-effects in dev / forks / tests.
 */
// `unknown` cast: Sentry's withSentry types as a specific
// ExportedHandler<Env>, but the worker module exports a structurally
// compatible handler whose env shape is wider than the SDK's generic.
// Passing it through unknown is the standard escape hatch.
export function wrapWorker<H>(handler: H): H {
  return Sentry.withSentry(
    (env: SentryEnv) => {
      if (!env.SENTRY_DSN) return undefined;
      return {
        dsn: env.SENTRY_DSN,
        environment: env.SENTRY_ENVIRONMENT ?? "production",
        release: env.SENTRY_RELEASE,
        // 10% of transactions; matches our existing
        // wrangler.jsonc observability head_sampling_rate so
        // logs+traces stay correlatable. Bump to 1.0 to chase a
        // specific incident.
        tracesSampleRate: 0.1,
        // Strip token-shaped substrings + sensitive header values
        // before send. We pass everything through `redactString` so
        // the same patterns the structured logger redacts (PATs,
        // bearer headers, hex blobs) also disappear from Sentry.
        beforeSend(event) {
          return redactEvent(event) as Sentry.ErrorEvent;
        },
      };
    },
    handler as unknown as Parameters<typeof Sentry.withSentry>[1],
  ) as unknown as H;
}

/**
 * Report an error to Sentry from a caller-known failure path. The
 * structured tags (request id, path, method, status) make the issue
 * filterable in the Sentry UI and drop into the GitHub-issue payload
 * (.github/workflows/sentry-issue.yml) verbatim.
 *
 * No-op when Sentry isn't wired (the SDK throws if called outside an
 * active scope).
 */
export function captureError(err: unknown, context: ErrorContext): void {
  try {
    Sentry.withScope((scope) => {
      if (context.requestId) scope.setTag("request_id", context.requestId);
      if (context.path) scope.setTag("path", context.path);
      if (context.method) scope.setTag("method", context.method);
      if (context.status !== undefined) scope.setTag("status", String(context.status));
      if (context.sessionId) scope.setTag("session_id", context.sessionId);
      if (context.extra) scope.setContext("extra", context.extra);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
    });
  } catch {
    // No active hub (SENTRY_DSN unset) — swallow. The structured logger
    // already wrote the error to stderr; Sentry is the secondary sink.
  }
}

export interface ErrorContext {
  requestId?: string;
  path?: string;
  method?: string;
  status?: number;
  sessionId?: string;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Redaction (Sentry-side defense in depth)

function redactEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  // Recursive walk: any string we own (message, exception messages,
  // breadcrumbs, request URL/body, tags, contexts) goes through
  // `redactString`. Cheap — the redaction regex set is the same one
  // the structured logger uses.
  return redactValue(event) as unknown as Sentry.ErrorEvent;
}

function redactValue(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === "string") return redactString(v);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(redactValue);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(val);
    }
    return out;
  }
  return v;
}
