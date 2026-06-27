// ============================================================
// Resilience primitives: retry-with-backoff + circuit breaker
//
// Hermes makes ~four classes of outbound HTTP call:
//   * E2B Sandbox API (launcher → e2b.dev)
//   * GitHub REST (launcher publish + amend → api.github.com)
//   * OpenCode runtime (sandbox runner → z.ai)
//   * Worker ↔ launcher (control-plane internal)
//
// All four can flake transiently (network, 5xx, rate-limit). Without
// guards a single E2B blip turns into a stack of orphaned sandboxes and
// a single GitHub 502 fails a publish that would have succeeded on
// retry.  This module gives both runtimes one tiny, dependency-free
// pair of primitives:
//
//   - `withRetry(fn, opts)` — exponential backoff with full jitter,
//     classifies errors via `opts.isRetryable` (defaults to "retry on
//     network errors + 5xx + 429"), honours an AbortSignal.
//
//   - `CircuitBreaker` — closed → open → half-open state machine.
//     Trips after N consecutive failures, fails fast for `coolDownMs`,
//     lets one probe through in half-open, closes on success. Trivial
//     to test, takes the same shape as `opossum` / `cockatiel` so we
//     can swap implementations later if we need streaming buckets,
//     hedged requests, etc.
//
// Why not pull in opossum / cockatiel?
//   - Both ship CommonJS that wrangler has to wrap; bundle size
//     budget (1 MiB, scripts/bundle-size.ts) leaves less than 200 KiB
//     of headroom for the kinds of features we never use.
//   - The functional surface we actually want is 150 LOC. Auditable.
//
// Usage:
//   import { withRetry, CircuitBreaker } from "@/core/resilience";
//
//   const breaker = new CircuitBreaker({
//     name: "e2b-list",
//     failureThreshold: 5,
//     coolDownMs: 30_000,
//   });
//
//   const resp = await breaker.run(() =>
//     withRetry(() => fetch("https://api.e2b.dev/v2/sandboxes", { headers }),
//       { name: "e2b-list", maxAttempts: 4, baseDelayMs: 200 }),
//   );
//
// Both helpers log via a passed-in `Logger` (src/core/logger.ts), so
// retries and trips show up as structured events tagged with the call
// name. No metrics are emitted directly — call sites use `log.metric`
// where they care.
// ============================================================

// Minimal logger surface this module needs. `src/core/logger.ts` (added
// in the structured-logging PR) implements this shape; falling back to a
// structural type here keeps this module standalone so PRs can land in
// either order without a merge conflict.
export interface ResilienceLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
type Logger = ResilienceLogger;

// ---------------------------------------------------------------------------
// Retry

export interface RetryOptions {
  /** Diagnostic label baked into every log line / error message. */
  name: string;
  /** Total attempts including the first call. Default 3. */
  maxAttempts?: number;
  /** Backoff base in ms; delay = random(0, baseDelayMs * 2^attempt). Default 200. */
  baseDelayMs?: number;
  /** Hard ceiling per-sleep so 2^attempt doesn't explode. Default 10_000 ms. */
  maxDelayMs?: number;
  /** Optional logger; falls back to no-op when omitted. */
  log?: Logger;
  /** AbortSignal; honoured between attempts (mid-call cancellation is the caller's job). */
  signal?: AbortSignal;
  /**
   * Decide whether a thrown error / returned Response is retryable.
   * Defaults to network errors + HTTP 5xx + 408 + 429.
   */
  isRetryable?: (err: unknown) => boolean;
}

const DEFAULT_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof RetryableHttpError) return DEFAULT_RETRYABLE_STATUSES.has(err.status);
  if (err instanceof Error) {
    // Best-effort match against the surface area `fetch` exposes in CF
    // Workers + Node + Bun. We deliberately treat "unknown" errors as
    // retryable since the alternative is a hard fail.
    const m = err.message.toLowerCase();
    if (
      m.includes("fetch failed") ||
      m.includes("network") ||
      m.includes("econnreset") ||
      m.includes("etimedout") ||
      m.includes("socket hang up") ||
      m.includes("temporarily unavailable")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Thrown by a caller's `fn` when the HTTP response itself indicates an
 * upstream error (e.g. a 503). The retry layer reads `.status` so it can
 * distinguish "permanent" 4xx from "retry me" 5xx.
 *
 * Usage:
 *   const r = await fetch(url);
 *   if (!r.ok) throw new RetryableHttpError(r.status, await r.text());
 */
export class RetryableHttpError extends Error {
  constructor(
    public readonly status: number,
    body?: string,
  ) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "RetryableHttpError";
  }
}

/** Async sleep that honours an AbortSignal. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  // Allow tests to replace random + sleep with deterministic stand-ins.
  hooks: { random?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const random = hooks.random ?? Math.random;
  const sleep = hooks.sleep ?? ((ms) => delay(ms, opts.signal));

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const willRetry = attempt < maxAttempts - 1 && isRetryable(err);
      opts.log?.warn("retry.attempt_failed", {
        name: opts.name,
        attempt: attempt + 1,
        maxAttempts,
        willRetry,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!willRetry) break;
      // Full-jitter exponential backoff. The "full" variant (random
      // between 0 and ceil) avoids the herd-thunder retry storms that
      // a fixed/equal-jitter scheme is prone to.
      const ceil = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await sleep(Math.floor(random() * ceil));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Circuit breaker

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Diagnostic label baked into every log line / metric tag. */
  name: string;
  /** Consecutive failures that flip closed → open. Default 5. */
  failureThreshold?: number;
  /** Time the breaker stays open before allowing a probe. Default 30 s. */
  coolDownMs?: number;
  /** Optional logger; falls back to no-op when omitted. */
  log?: Logger;
  /** Pluggable clock for tests; defaults to Date.now. */
  now?: () => number;
  /**
   * Decide whether an error should count toward the failure budget.
   * Defaults to `defaultIsRetryable` — i.e. only "transient" errors trip
   * the breaker; a permanent 4xx leaves the breaker closed because
   * retrying won't help.
   */
  isFailure?: (err: unknown) => boolean;
}

export class CircuitOpenError extends Error {
  constructor(public readonly breakerName: string) {
    super(`Circuit '${breakerName}' is open`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly coolDownMs: number;
  private readonly now: () => number;
  private readonly isFailure: (err: unknown) => boolean;
  private readonly log?: Logger;
  public readonly name: string;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.coolDownMs = opts.coolDownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.isFailure = opts.isFailure ?? defaultIsRetryable;
    this.log = opts.log;
  }

  /** Current state; intended for tests + dashboards. */
  get currentState(): CircuitState {
    if (this.state === "open" && this.now() - this.openedAt >= this.coolDownMs) {
      // Lazily transition to half_open the moment we *check*; this means
      // a caller reading the state sees an honest answer without us
      // running a timer.
      this.state = "half_open";
      this.log?.info("breaker.half_open", { name: this.name });
    }
    return this.state;
  }

  /**
   * Wrap `fn` with the breaker:
   *   - closed: pass through; record success/failure.
   *   - open: fail fast with CircuitOpenError until coolDownMs elapses.
   *   - half_open: allow one probe; success → closed, failure → open again.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;
    if (state === "open") {
      this.log?.warn("breaker.fast_fail", { name: this.name });
      throw new CircuitOpenError(this.name);
    }
    try {
      const out = await fn();
      this.recordSuccess();
      return out;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    }
  }

  private recordSuccess(): void {
    if (this.state !== "closed") {
      this.log?.info("breaker.closed", { name: this.name });
    }
    this.state = "closed";
    this.consecutiveFailures = 0;
  }

  private recordFailure(err: unknown): void {
    if (!this.isFailure(err)) {
      // Permanent / non-transient failures don't move the breaker. The
      // caller's bug fix will close it; we don't want a wave of 422s to
      // pop the breaker and DoS ourselves.
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold || this.state === "half_open") {
      if (this.state !== "open") {
        this.log?.error("breaker.open", {
          name: this.name,
          consecutiveFailures: this.consecutiveFailures,
          coolDownMs: this.coolDownMs,
        });
      }
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}

// ---------------------------------------------------------------------------
// Composition helper

/**
 * Shorthand for `breaker.run(() => withRetry(fn, retryOpts))`. Most
 * external call sites want both behaviours at once; this saves one
 * level of nesting.
 */
export function withResilience<T>(
  breaker: CircuitBreaker,
  retryOpts: RetryOptions,
  fn: () => Promise<T>,
): Promise<T> {
  return breaker.run(() => withRetry(fn, retryOpts));
}
