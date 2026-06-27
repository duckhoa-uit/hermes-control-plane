// Tests for src/core/resilience.ts.
//
// The retry + circuit-breaker primitives are dependency-free and pure
// state-machine code, so we exercise every transition deterministically
// (no real timers, no real randomness, no real fetch).

import { describe, it, expect } from "vitest";
import {
  withRetry,
  CircuitBreaker,
  CircuitOpenError,
  RetryableHttpError,
  defaultIsRetryable,
  withResilience,
} from "../src/core/resilience";

// ---------------------------------------------------------------------------
// withRetry

describe("withRetry", () => {
  it("returns the value on first success without delay", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      { name: "t", maxAttempts: 3 },
      { sleep: async () => undefined },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient failures up to maxAttempts then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new RetryableHttpError(503);
        return "third-time-lucky";
      },
      { name: "t", maxAttempts: 5, baseDelayMs: 100 },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.5, // deterministic half-jitter
      },
    );
    expect(result).toBe("third-time-lucky");
    expect(calls).toBe(3);
    // Two sleeps because we needed two retries.
    expect(sleeps).toHaveLength(2);
    // 100 * 2^0 * 0.5 = 50, 100 * 2^1 * 0.5 = 100
    expect(sleeps).toEqual([50, 100]);
  });

  it("re-throws when all attempts are exhausted", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new RetryableHttpError(502);
        },
        { name: "t", maxAttempts: 3 },
        { sleep: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    expect(calls).toBe(3);
  });

  it("does not retry permanent errors (4xx other than 408/425/429)", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new RetryableHttpError(404);
        },
        { name: "t", maxAttempts: 5 },
        { sleep: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    expect(calls).toBe(1);
  });

  it("retries 429 (rate limit) by default", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new RetryableHttpError(429);
        },
        { name: "t", maxAttempts: 2 },
        { sleep: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    expect(calls).toBe(2);
  });

  it("retries common network error messages", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("fetch failed: ECONNRESET");
        },
        { name: "t", maxAttempts: 3 },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow(/ECONNRESET/);
    expect(calls).toBe(3);
  });

  it("respects a custom isRetryable predicate", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("custom-permanent");
        },
        {
          name: "t",
          maxAttempts: 5,
          isRetryable: (err) => err instanceof Error && !err.message.includes("permanent"),
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow("custom-permanent");
    expect(calls).toBe(1);
  });

  it("caps backoff at maxDelayMs", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new RetryableHttpError(500);
        },
        { name: "t", maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 2500 },
        {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          random: () => 1, // ceil
        },
      ),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    // Sleeps are floor(random()*ceil); random=1 → 0.999…→ floor is ceil-1.
    // Just assert nothing exceeds the cap.
    for (const ms of sleeps) {
      expect(ms).toBeLessThanOrEqual(2500);
    }
  });
});

describe("defaultIsRetryable", () => {
  it("treats RetryableHttpError 5xx + 408/425/429 as retryable", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(defaultIsRetryable(new RetryableHttpError(status))).toBe(true);
    }
  });
  it("treats other RetryableHttpError statuses as non-retryable", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(defaultIsRetryable(new RetryableHttpError(status))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// CircuitBreaker

describe("CircuitBreaker", () => {
  function clock(): { now: () => number; advance: (ms: number) => void } {
    let t = 1_000_000;
    return {
      now: () => t,
      advance: (ms) => {
        t += ms;
      },
    };
  }

  it("starts closed and stays closed on success", async () => {
    const c = clock();
    const b = new CircuitBreaker({ name: "x", now: c.now });
    expect(b.currentState).toBe("closed");
    await b.run(async () => "ok");
    expect(b.currentState).toBe("closed");
  });

  it("opens after failureThreshold consecutive transient failures", async () => {
    const c = clock();
    const b = new CircuitBreaker({ name: "x", failureThreshold: 3, now: c.now });
    for (let i = 0; i < 3; i++) {
      await expect(
        b.run(async () => {
          throw new RetryableHttpError(503);
        }),
      ).rejects.toBeInstanceOf(RetryableHttpError);
    }
    expect(b.currentState).toBe("open");
  });

  it("fails fast with CircuitOpenError while open", async () => {
    const c = clock();
    const b = new CircuitBreaker({ name: "x", failureThreshold: 2, now: c.now });
    for (let i = 0; i < 2; i++) {
      await expect(
        b.run(async () => {
          throw new RetryableHttpError(503);
        }),
      ).rejects.toBeInstanceOf(RetryableHttpError);
    }
    let downstreamCalls = 0;
    await expect(
      b.run(async () => {
        downstreamCalls++;
        return "should-never-run";
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(downstreamCalls).toBe(0);
  });

  it("transitions to half_open after coolDownMs", async () => {
    const c = clock();
    const b = new CircuitBreaker({
      name: "x",
      failureThreshold: 1,
      coolDownMs: 1000,
      now: c.now,
    });
    await expect(
      b.run(async () => {
        throw new RetryableHttpError(503);
      }),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    expect(b.currentState).toBe("open");

    c.advance(999);
    expect(b.currentState).toBe("open");

    c.advance(1);
    expect(b.currentState).toBe("half_open");
  });

  it("closes again on half_open success", async () => {
    const c = clock();
    const b = new CircuitBreaker({
      name: "x",
      failureThreshold: 1,
      coolDownMs: 100,
      now: c.now,
    });
    await expect(
      b.run(async () => {
        throw new RetryableHttpError(503);
      }),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    c.advance(101);
    await b.run(async () => "recovered");
    expect(b.currentState).toBe("closed");
  });

  it("reopens immediately on half_open failure", async () => {
    const c = clock();
    const b = new CircuitBreaker({
      name: "x",
      failureThreshold: 1,
      coolDownMs: 100,
      now: c.now,
    });
    await expect(
      b.run(async () => {
        throw new RetryableHttpError(503);
      }),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    c.advance(101);
    expect(b.currentState).toBe("half_open");
    await expect(
      b.run(async () => {
        throw new RetryableHttpError(503);
      }),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    expect(b.currentState).toBe("open");
  });

  it("ignores non-transient errors when counting failures", async () => {
    const c = clock();
    const b = new CircuitBreaker({ name: "x", failureThreshold: 2, now: c.now });
    // Two permanent 404s should NOT open the breaker — retrying or
    // fast-failing wouldn't help anyway.
    for (let i = 0; i < 5; i++) {
      await expect(
        b.run(async () => {
          throw new RetryableHttpError(404);
        }),
      ).rejects.toBeInstanceOf(RetryableHttpError);
    }
    expect(b.currentState).toBe("closed");
  });

  it("resets the consecutive-failure counter on success", async () => {
    const c = clock();
    const b = new CircuitBreaker({ name: "x", failureThreshold: 3, now: c.now });
    await expect(
      b.run(async () => {
        throw new RetryableHttpError(503);
      }),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    await b.run(async () => "ok");
    // One more transient failure should NOT open the breaker because the
    // counter was reset.
    await expect(
      b.run(async () => {
        throw new RetryableHttpError(503);
      }),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    expect(b.currentState).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// withResilience composition

describe("withResilience", () => {
  it("composes breaker + retry: retries inside, breaker outside", async () => {
    const c = { now: () => 1_000_000 };
    const breaker = new CircuitBreaker({
      name: "compose",
      failureThreshold: 10,
      now: c.now,
    });
    let calls = 0;
    const out = await withResilience(breaker, { name: "compose", maxAttempts: 3 }, async () => {
      calls++;
      if (calls < 2) throw new RetryableHttpError(503);
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(2);
    expect(breaker.currentState).toBe("closed");
  });

  it("fails fast when the breaker is already open (fn never called)", async () => {
    const c = { now: () => 1_000_000 };
    const breaker = new CircuitBreaker({
      name: "compose",
      failureThreshold: 1,
      coolDownMs: 60_000,
      now: c.now,
    });
    // Prime the breaker into open.
    await expect(
      withResilience(breaker, { name: "compose", maxAttempts: 1 }, async () => {
        throw new RetryableHttpError(503);
      }),
    ).rejects.toBeInstanceOf(RetryableHttpError);
    expect(breaker.currentState).toBe("open");

    let calls = 0;
    await expect(
      withResilience(breaker, { name: "compose", maxAttempts: 5 }, async () => {
        calls++;
        return "never";
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(0);
  });
});
