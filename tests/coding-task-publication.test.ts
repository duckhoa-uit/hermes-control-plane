import { describe, expect, it } from "vitest";
import { claimPublication } from "../src/do/publication-lease";
import { settleCodingTaskRecord } from "../src/core/coding-task-settlement";
import type { CodingTaskRecord } from "../src/do/coding-task-do";

const task: CodingTaskRecord = {
  id: "task_0123456789abcdef0123456789abcdef",
  sessionId: "control-plan-task_0123456789abcdef0123456789abcdef",
  repository: "owner/repo",
  baseBranch: "main",
  branch: "control-plan/0123456789abcdef",
  task: "Make the requested change",
  executionMode: "workflow",
  state: "dispatched",
  createdAt: 1,
  updatedAt: 1,
  replayUrl: "https://example.test/replay",
};

describe("task publication lease", () => {
  it("claims a dispatched task with a timestamp and owner", () => {
    const result = claimPublication(task, task.sessionId, 1234);
    expect(result).toMatchObject({
      claimed: true,
      task: {
        state: "publishing",
        publicationSessionId: task.sessionId,
        publicationStartedAt: 1234,
      },
    });
  });

  it("allows an idempotent retry from the owning session", () => {
    const publishing = {
      ...task,
      state: "publishing" as const,
      publicationSessionId: task.sessionId,
      publicationStartedAt: 1234,
    };
    expect(claimPublication(publishing, task.sessionId, 999)).toEqual({
      claimed: true,
      task: publishing,
    });
  });

  it("rejects a different session while publication is in progress", () => {
    const publishing = {
      ...task,
      state: "publishing" as const,
      publicationSessionId: task.sessionId,
      publicationStartedAt: 1234,
    };
    expect(claimPublication(publishing, "other-session")).toMatchObject({
      claimed: false,
      reason: "owned_by_other_session",
    });
  });

  it.each([
    "created",
    "cancellation_requested",
    "cancelled",
    "completed",
    "failed",
  ] as const)("rejects a %s task before a GitHub write", (state) => {
    expect(claimPublication({ ...task, state }, task.sessionId).claimed).toBe(false);
  });
});

describe("workflow settlement contract", () => {
  const output = {
    outcome: "no_change" as const,
    summary: "No source changes were required.",
    verification: [],
  };

  it("completes a dispatched no-change workflow", () => {
    expect(settleCodingTaskRecord(task, output)).toMatchObject({
      state: "completed",
      outcome: "no_change",
      summary: output.summary,
    });
  });

  it("fails closed when a publication lease has no durable result", () => {
    const publishing = {
      ...task,
      state: "publishing" as const,
      publicationSessionId: task.sessionId,
    };
    expect(settleCodingTaskRecord(publishing, output)).toMatchObject({
      state: "failed",
      outcome: "blocked",
      blockedReason: "Workflow ended while publication was in progress without a durable result",
    });
  });

  it("keeps a durable publication authoritative over the model outcome", () => {
    const published = {
      ...task,
      state: "publishing" as const,
      result: { branch: task.branch, commitSha: "abc123" },
    };
    expect(settleCodingTaskRecord(published, output)).toMatchObject({
      state: "completed",
      outcome: "published",
      result: published.result,
    });
  });
});
