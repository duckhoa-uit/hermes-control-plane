import { describe, expect, it, vi } from "vitest";
import { createFinalizeChangeAction } from "../src/agent/control-plan-finalize-action";
import type { CodingTaskRecord } from "../src/do/coding-task-do";

const baseTask: CodingTaskRecord = {
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

describe("finalize_change Action boundary", () => {
  it.each([
    "cancellation_requested",
    "cancelled",
  ] as const)("blocks publication when task state is %s", async (state) => {
    const task = { ...baseTask, state };
    const sandboxSession = vi.fn();
    const action = createFinalizeChangeAction({
      env: { APPROVAL_MODE: "policy" } as Env,
      id: task.sessionId,
      baseUrl: "https://control-plan.example",
      approvalDO: {} as never,
      taskStub: null,
      taskRecord: async () => task,
      sandboxSession,
      authorName: "Control Plan",
      authorEmail: "bot@example.test",
    });

    await expect(
      action.run({
        input: {
          branch: task.branch,
          commitMessage: "test: blocked cancellation",
          prBody: "",
          baseBranch: task.baseBranch,
          createPr: false,
          force: false,
        },
        harness: {} as never,
        log: { info: vi.fn() } as never,
      }),
    ).rejects.toThrow("finalization is blocked");
    expect(sandboxSession).not.toHaveBeenCalled();
  });

  it("rejects a branch that is outside the task binding before touching the sandbox", async () => {
    const sandboxSession = vi.fn();
    const action = createFinalizeChangeAction({
      env: { APPROVAL_MODE: "policy" } as Env,
      id: baseTask.sessionId,
      baseUrl: "https://control-plan.example",
      approvalDO: {} as never,
      taskStub: null,
      taskRecord: async () => baseTask,
      sandboxSession,
      authorName: "Control Plan",
      authorEmail: "bot@example.test",
    });

    await expect(
      action.run({
        input: {
          branch: "control-plan/ffffffffffffffff",
          commitMessage: "test: wrong branch",
          prBody: "",
          baseBranch: baseTask.baseBranch,
          createPr: false,
          force: false,
        },
        harness: {} as never,
        log: { info: vi.fn() } as never,
      }),
    ).rejects.toThrow("must use task branch");
    expect(sandboxSession).not.toHaveBeenCalled();
  });
});
