import { describe, expect, it, vi } from "vitest";
import {
  codingTaskId,
  taskBranch,
  taskIdFromSessionId,
  taskLifecycle,
  repositoryParts,
} from "../src/mcp/task-utils";
import { invokeCodingTaskWorkflow, normalizeOpenApprovals } from "../src/mcp/control-plan";

vi.mock("../src/workflows/coding-task", () => ({
  default: { name: "coding-task-test-definition" },
}));

describe("Control Plan MCP policy", () => {
  it("uses a stable, repository-scoped task idempotency key", async () => {
    const first = await codingTaskId("duckhoa-uit/lawn", "issue-42");
    const repeated = await codingTaskId("duckhoa-uit/lawn", "issue-42");
    const otherRepository = await codingTaskId("example/private-repo", "issue-42");

    expect(first).toMatch(/^task_[a-f0-9]{32}$/);
    expect(repeated).toBe(first);
    expect(otherRepository).not.toBe(first);
  });

  it("derives an isolated publication branch and task session", async () => {
    const taskId = await codingTaskId("duckhoa-uit/lawn", "issue-43");
    expect(taskBranch(taskId)).toBe(`control-plan/${taskId.slice(5, 21)}`);
    expect(taskIdFromSessionId(`control-plan-${taskId}`)).toBe(taskId);
    expect(taskIdFromSessionId("manual-session")).toBeNull();
  });

  it("parses repository targets without accepting arbitrary URLs", () => {
    expect(repositoryParts("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(repositoryParts("https://github.com/owner/repo")).toBeNull();
  });

  it("normalizes the approval DO envelope to the MCP array shape", () => {
    expect(normalizeOpenApprovals({ approvals: [{ id: "approval-1" }] })).toEqual([
      { id: "approval-1" },
    ]);
    expect(normalizeOpenApprovals({ approvals: null })).toEqual([]);
    expect(normalizeOpenApprovals([])).toEqual([]);
  });

  it("treats dispatched work as active and tells Hermes to poll", () => {
    expect(taskLifecycle("dispatched")).toEqual({
      terminal: false,
      nextAction: "poll",
      pollAfterMs: 15_000,
    });
    expect(taskLifecycle("publishing")).toEqual({
      terminal: false,
      nextAction: "poll",
      pollAfterMs: 15_000,
    });
    expect(taskLifecycle("dispatched", true)).toEqual({
      terminal: false,
      nextAction: "respond_to_approval",
      pollAfterMs: 15_000,
    });
  });

  it("only marks completed, failed, and cancelled states as terminal", () => {
    expect(taskLifecycle("completed")).toEqual({ terminal: true, nextAction: "report" });
    expect(taskLifecycle("failed")).toEqual({ terminal: true, nextAction: "report" });
    expect(taskLifecycle("cancellation_requested").terminal).toBe(false);
    expect(taskLifecycle("cancelled")).toEqual({ terminal: true, nextAction: "report" });
  });

  it("routes coding dispatch through the injected workflow runtime", async () => {
    let received: { workflow: unknown; input: unknown } | undefined;
    const result = await invokeCodingTaskWorkflow(
      {
        invoke: async (workflow, request) => {
          received = { workflow, input: request.input };
          return { runId: "run-coding-1" };
        },
        getRun: async () => null,
      },
      {
        taskId: "task_0123456789abcdef0123456789abcdef",
        repository: "owner/repo",
        baseBranch: "main",
        branch: "control-plan/task-1",
        task: "Run the bounded coding task",
      },
    );

    expect(result).toEqual({ runId: "run-coding-1" });
    expect(received?.workflow).toBeDefined();
    expect(received?.input).toMatchObject({ repository: "owner/repo" });
  });
});
