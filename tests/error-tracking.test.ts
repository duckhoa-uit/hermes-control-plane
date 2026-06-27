// Tests for src/core/error-tracking.ts.
//
// The Sentry wrapper has two failure modes that need automated coverage:
//
//   1. `captureError` must be a no-op when SENTRY_DSN is unset (i.e.
//      no active Sentry hub). Otherwise tests + forks + dev would
//      throw uncaught.
//   2. The wrapper's `beforeSend` redaction must scrub the same
//      token-shaped strings the structured logger scrubs. Otherwise a
//      secret leaked into a thrown error would land in Sentry — the
//      exact failure mode the wrapper is supposed to prevent.
//
// We don't unit-test `wrapWorker` directly (that would require booting
// the Workers runtime); the e2e tests already exercise the unwrapped
// handler.

import { describe, it, expect } from "vitest";
import { captureError } from "../src/core/error-tracking";
import { redactString } from "../src/core/logger";

describe("captureError", () => {
  it("is a no-op when no Sentry hub is active (does not throw)", () => {
    expect(() =>
      captureError(new Error("boom"), {
        requestId: "abc",
        path: "/sessions",
        method: "POST",
        status: 500,
      }),
    ).not.toThrow();
  });

  it("accepts non-Error values without crashing", () => {
    expect(() => captureError("not-an-error", { requestId: "x" })).not.toThrow();
    expect(() => captureError({ shape: "object" }, { requestId: "x" })).not.toThrow();
    expect(() => captureError(undefined, { requestId: "x" })).not.toThrow();
  });
});

describe("redaction (shared with the structured logger)", () => {
  // We exercise `redactString` here too because the Sentry wrapper's
  // `beforeSend` is built on top of it; if the helper's behaviour
  // regresses, the Sentry sink would start leaking secrets even if
  // logger.test.ts goes green.

  const A20 = "A".repeat(20);

  it("redacts GitHub PAT-shaped values", () => {
    const fake = `g${"hp_FAKE"}${A20}`;
    const out = redactString(`Failed to push: token=${fake}`);
    expect(out).toBe("Failed to push: token=[redacted]");
  });

  it("keeps the `Bearer`/`Token` prefix in Authorization values", () => {
    const fake = `FAKETOKEN${A20}`;
    const out = redactString(`Authorization: Bearer ${fake}`);
    expect(out).toBe("Authorization: Bearer [redacted]");
  });

  it("redacts E2B / Z.AI API keys", () => {
    const e2b = `e2${"b_FAKE"}${A20}`;
    const zai = `za${"i_FAKE"}${A20}`;
    expect(redactString(`E2B_API_KEY=${e2b}`)).toBe("E2B_API_KEY=[redacted]");
    expect(redactString(`ZAI_API_KEY=${zai}`)).toBe("ZAI_API_KEY=[redacted]");
  });
});
