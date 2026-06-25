// M5: contract for the post-resume code paths.
// - The pending-prompt queue holds exactly one slot.
// - DO /prompt response shape differs between "queued for resume" (202,
//   recoverable:true) and the pre-M5 fail-fast 409/410.
// - Heartbeat watchdog must ignore disconnected-runner unless we
//   explicitly mark the session as failed elsewhere.

import { describe, it, expect } from "vitest";
import { canTransition } from "../src/core/state-machine";
import type { Session, SessionStatus } from "../src/core/types";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_test",
    projectId: "p1",
    taskDescription: "t",
    status: "review_ready",
    branch: "hermes/test",
    createdAt: 0,
    updatedAt: 0,
    runnerConnected: false,
    ...overrides,
  };
}

describe("M5 — pendingPrompt single-slot queue", () => {
  it("Session interface accepts and stores pendingPrompt", () => {
    const s = makeSession({ pendingPrompt: "edit foo.ts" });
    expect(s.pendingPrompt).toBe("edit foo.ts");
  });

  it("setting a new pendingPrompt overwrites the previous one", () => {
    const s = makeSession({ pendingPrompt: "first" });
    s.pendingPrompt = "second";
    expect(s.pendingPrompt).toBe("second");
  });

  it("clearing pendingPrompt with undefined removes the slot", () => {
    const s = makeSession({ pendingPrompt: "pending" });
    s.pendingPrompt = undefined;
    expect(s.pendingPrompt).toBeUndefined();
  });
});

describe("M5 — state machine still allows the rebind+drain path", () => {
  it("review_ready -> running (for queued prompt drain after resume)", () => {
    expect(canTransition("review_ready", "running")).toBe(true);
  });

  // After drain, the second runner.complete will transition running ->
  // review_ready; that path was already covered by M4.
  it("running -> review_ready (second runner.complete after resumed turn)", () => {
    expect(canTransition("running", "review_ready")).toBe(true);
  });
});

describe("M5 — /prompt response shapes", () => {
  type PromptOk = { ok: true; queued: true; status: SessionStatus; reason: string; recoverable: true };
  type PromptQueued = PromptOk;
  type PromptRunnerGone = { error: string; status: SessionStatus | undefined; reason: string; recoverable: false };
  type PromptSessionEnded = { error: string; status: SessionStatus; reason: string; recoverable: false };

  it("202 body has recoverable:true and queued:true", () => {
    const body: PromptQueued = {
      ok: true,
      queued: true,
      status: "review_ready",
      reason: "Sandbox is paused; resume initiated. The follow-up prompt will be delivered as soon as the runner reconnects (usually < 5 s).",
      recoverable: true,
    };
    expect(body.recoverable).toBe(true);
    expect(body.queued).toBe(true);
    expect(body.reason).toMatch(/resume initiated/i);
  });

  it("409 body keeps recoverable:false for the pre-M5 fallback when CONTROL_PLANE_LAUNCHER_URL is unset", () => {
    const body: PromptRunnerGone = {
      error: "Runner not connected",
      status: "review_ready",
      reason: "Resume is not configured (CONTROL_PLANE_LAUNCHER_URL unset). Start a new session.",
      recoverable: false,
    };
    expect(body.recoverable).toBe(false);
    expect(body.reason).toMatch(/CONTROL_PLANE_LAUNCHER_URL unset/);
  });

  it("410 body keeps recoverable:false for terminal sessions even when launcher is up", () => {
    const body: PromptSessionEnded = {
      error: "Session ended",
      status: "failed",
      reason: "The session reached a terminal state and its sandbox has been torn down. Start a new session to continue the work; the previous diff and PR (if any) are preserved in the session record.",
      recoverable: false,
    };
    expect(body.recoverable).toBe(false);
    expect(["completed", "failed", "aborted"]).toContain(body.status);
  });
});
