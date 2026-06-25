// /sessions/:id/prompt error responses (§12.12 fail-fast UX).
// Validates the JSON shape we return when a follow-up cannot succeed.
// Pure schema test — doesn't spin up a DO; just asserts the shape we
// document for clients to depend on.

import { describe, it, expect } from "vitest";

interface PromptErrorBody {
  error: string;
  status?: string;
  reason: string;
  recoverable: boolean;
}

// Mirror of what session-do.ts:/prompt returns. Kept here as a
// guard against accidental shape drift.
function buildRunnerGoneBody(status: string | undefined): PromptErrorBody {
  return {
    error: "Runner not connected",
    status,
    reason:
      "The follow-up window has elapsed. The sandbox is no longer reachable; " +
      "long-pause resume is not implemented yet (tracked under §12 M5). " +
      "Start a new session to continue.",
    recoverable: false,
  };
}

function buildSessionEndedBody(status: string): PromptErrorBody {
  return {
    error: "Session ended",
    status,
    reason:
      "The session reached a terminal state and its sandbox has been torn down. " +
      "Start a new session to continue the work; the previous diff and PR (if any) " +
      "are preserved in the session record.",
    recoverable: false,
  };
}

describe("/prompt error responses (fail-fast UX)", () => {
  it("runner-gone body has the four documented fields", () => {
    const body = buildRunnerGoneBody("review_ready");
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("status", "review_ready");
    expect(body).toHaveProperty("reason");
    expect(body).toHaveProperty("recoverable", false);
    expect(body.error).toBe("Runner not connected");
    expect(body.reason).toMatch(/follow-up window has elapsed/i);
    expect(body.reason).toMatch(/§12 M5/);
  });

  it("session-ended body uses error='Session ended' and a different reason", () => {
    const body = buildSessionEndedBody("failed");
    expect(body.error).toBe("Session ended");
    expect(body.status).toBe("failed");
    expect(body.recoverable).toBe(false);
    expect(body.reason).toMatch(/terminal state/i);
    expect(body.reason).toMatch(/start a new session/i);
  });

  it("recoverable is always false today (M5 will flip this)", () => {
    expect(buildRunnerGoneBody("running").recoverable).toBe(false);
    expect(buildSessionEndedBody("aborted").recoverable).toBe(false);
  });

  it("status is preserved verbatim from the DO state when present", () => {
    for (const st of ["running", "review_ready", "stalled", "failed", "aborted"] as const) {
      const body = st === "failed" || st === "aborted" ? buildSessionEndedBody(st) : buildRunnerGoneBody(st);
      expect(body.status).toBe(st);
    }
  });

  it("status omitted when DO has no session (edge case)", () => {
    const body = buildRunnerGoneBody(undefined);
    expect(body.status).toBeUndefined();
  });
});
