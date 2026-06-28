// ============================================================
// Resilience — Retry with backoff + circuit breaker
// ============================================================
// Wraps external API calls (GitHub, Z.AI, Webhooks) in retry
// logic with exponential backoff (+ jitter) and a circuit
// breaker to avoid cascading failures.

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  retryOn?: (status: number) => boolean;
}

const DEFAULT_RETRY: Required<RetryConfig> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  retryOn: (status) => status >= 500 || status === 429,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY, ...config };
  let lastErr: unknown;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === cfg.maxAttempts) break;

      const delay = Math.min(
        cfg.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * cfg.baseDelayMs,
        cfg.maxDelayMs,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastErr;
}

// ─── Circuit Breaker ───────────────────────────────────────────

type CbState = "closed" | "open" | "half-open";

interface CbOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
}

export class CircuitBreaker {
  private state: CbState = "closed";
  private failures = 0;
  private lastFailureTime = 0;

  constructor(private options: CbOptions = { failureThreshold: 5, resetTimeoutMs: 30_000 }) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime > this.options.resetTimeoutMs) {
        this.state = "half-open";
      } else {
        throw new Error("Circuit breaker is open");
      }
    }

    try {
      const result = await fn();
      if (this.state === "half-open") {
        this.state = "closed";
        this.failures = 0;
      }
      return result;
    } catch (err) {
      this.failures++;
      this.lastFailureTime = Date.now();
      if (this.failures >= this.options.failureThreshold) {
        this.state = "open";
      }
      throw err;
    }
  }

  getState(): CbState {
    return this.state;
  }

  reset(): void {
    this.state = "closed";
    this.failures = 0;
  }
}
