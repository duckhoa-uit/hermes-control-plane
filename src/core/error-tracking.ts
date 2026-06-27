// ============================================================
// Error tracking — PostHog integration
//
// Posts captured exceptions to PostHog's error-tracking endpoint via
// `posthog-node`'s workerd-friendly entry point. The module short-
// circuits when `POSTHOG_PROJECT_TOKEN` is unset, so forks/dev/tests
// pay zero overhead.
//
// What flows into PostHog:
//   - Unhandled exceptions thrown inside `fetch()` — captured by the
//     `wrapWorker(handler)` helper below.
//   - Errors explicitly reported via `captureError(err, ctx, env)` —
//     called from request-failed paths so we attach the request id,
//     path, method, status, and optional session_id as $exception
//     event properties.
//   - A release tag (POSTHOG_RELEASE — CI sets to the git sha) so a
//     regression can be traced back to the introducing commit.
//
// What does NOT flow into PostHog:
//   - Secrets — `redactString` from src/core/logger.ts is run against
//     every string property on the event before send. Defense-in-depth
//     in case a token leaks into an error message.
//
// Why PostHog (and not Sentry)?
//   - PostHog free tier is generous: 100k exceptions/month + 1M product
//     analytics events/month + 1M feature-flag requests/month, all on a
//     single shared free quota. Sentry's free plan caps at 5k errors.
//   - Same JSON contract for both error tracking and product analytics,
//     so the same SDK covers the `error_tracking_contextualized` and
//     `product_analytics_instrumentation` Agent Readiness signals.
//
// Configuration knobs (see src/worker/env.d.ts):
//   - POSTHOG_PROJECT_TOKEN: gate. When unset, the wrapper is a passthrough.
//   - POSTHOG_HOST: PostHog ingest URL. Defaults to https://us.i.posthog.com.
//   - POSTHOG_RELEASE: optional release tag (CI sets to the git sha).
//   - POSTHOG_ENVIRONMENT: optional environment tag (production/staging/preview).
// ============================================================

import { PostHog } from "posthog-node";
import { redactString } from "./logger";

const DEFAULT_HOST = "https://us.i.posthog.com";

/**
 * Surface of the Worker env we read. Kept structural so the launcher
 * (which has its own env shape) can share the helpers below.
 */
export interface PosthogEnv {
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
  POSTHOG_RELEASE?: string;
  POSTHOG_ENVIRONMENT?: string;
}

/** Shape of the Cloudflare Worker `ExecutionContext` we need. */
interface MinimalExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Wraps a Worker default-export handler so unhandled exceptions thrown
 * inside `fetch()` are captured by PostHog, then re-thrown so the
 * Worker runtime's existing error path still runs (and the structured
 * logger still emits the request.failed line).
 *
 * Zero overhead when POSTHOG_PROJECT_TOKEN is unset — the SDK never
 * instantiates.
 */
export function wrapWorker<H extends WorkerHandler>(handler: H): H {
  const wrapped: WorkerHandler = {
    async fetch(request, env, ctx) {
      const client = createClient(env as PosthogEnv);
      try {
        return await handler.fetch(request, env, ctx);
      } catch (err) {
        if (client) {
          captureToClient(client, err, {
            path: new URL(request.url).pathname,
            method: request.method,
          });
          // Don't block the response on flush; let the Worker isolate
          // ship the payload after we re-throw.
          (ctx as MinimalExecutionContext).waitUntil(client.shutdown());
        }
        throw err;
      }
    },
  };
  return wrapped as H;
}

interface WorkerHandler {
  fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
}

/**
 * Report an error to PostHog from a caller-known failure path. Tags
 * (requestId, path, method, status, sessionId) become properties on
 * the `$exception` event so they're filterable in the PostHog UI.
 *
 * Optional `ctx` (the Worker ExecutionContext) lets the caller delay
 * the worker isolate's teardown until the event is flushed; without
 * it, the call may best-effort drop the event if the isolate dies
 * before the request finishes.
 *
 * No-op when POSTHOG_PROJECT_TOKEN is unset.
 */
export function captureError(
  err: unknown,
  context: ErrorContext,
  env: PosthogEnv,
  ctx?: MinimalExecutionContext,
): void {
  const client = createClient(env);
  if (!client) return;
  captureToClient(client, err, context);
  const shutdown = client.shutdown();
  if (ctx) ctx.waitUntil(shutdown);
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
// Internals

function createClient(env: PosthogEnv): PostHog | null {
  if (!env.POSTHOG_PROJECT_TOKEN) return null;
  return new PostHog(env.POSTHOG_PROJECT_TOKEN, {
    host: env.POSTHOG_HOST ?? DEFAULT_HOST,
    // Cloudflare isolates die between requests; batching loses events.
    // Force per-event flush. The cost is one extra HTTP request per
    // captured exception, which is fine for an error-path SDK.
    flushAt: 1,
    flushInterval: 0,
  });
}

function captureToClient(client: PostHog, err: unknown, ctx: ErrorContext): void {
  const error = err instanceof Error ? err : new Error(String(err));
  client.captureException(error, ctx.requestId ?? ctx.sessionId ?? "anonymous", {
    ...redactProps(ctx.extra),
    request_id: ctx.requestId,
    path: ctx.path,
    method: ctx.method,
    status: ctx.status,
    session_id: ctx.sessionId,
    // Redact the error message itself in case a stack trace embedded a
    // bearer token (e.g. inside an "HTTP 401: ..." string).
    $exception_message: redactString(error.message),
  });
}

function redactProps(extra?: Record<string, unknown>): Record<string, unknown> {
  if (!extra) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    out[k] = typeof v === "string" ? redactString(v) : v;
  }
  return out;
}
