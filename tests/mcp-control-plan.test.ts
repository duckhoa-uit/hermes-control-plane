import { describe, expect, it } from "vitest";
import {
  codingTaskId,
  taskStateFromEvents,
  taskStateFromHistory,
  taskBranch,
  taskIdFromSessionId,
  taskLifecycle,
  repositoryParts,
} from "../src/mcp/task-utils";

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

  it("treats dispatched work as active and tells Hermes to poll", () => {
    expect(taskLifecycle("dispatched")).toEqual({
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

  it("only marks completed and failed states as terminal", () => {
    expect(taskLifecycle("completed")).toEqual({ terminal: true, nextAction: "report" });
    expect(taskLifecycle("failed")).toEqual({ terminal: true, nextAction: "report" });
    expect(taskLifecycle("cancellation_requested").terminal).toBe(false);
  });
});

describe("Control Plan MCP event reconciliation", () => {
  it("marks an idle agent as completed and returns its final message", () => {
    expect(
      taskStateFromEvents([
        {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Checks passed" }] },
        },
        { type: "idle" },
      ]),
    ).toEqual({ state: "completed", summary: "Checks passed" });
  });

  it("prefers a failed terminal event over an idle event", () => {
    expect(
      taskStateFromEvents([
        { type: "idle" },
        { type: "turn", isError: true, response: { error: { message: "model failed" } } },
      ]),
    ).toEqual({ state: "failed", summary: "model failed" });
  });

  it("reconciles beta.9 history settlements", () => {
    expect(
      taskStateFromHistory(
        {
          offset: "0000000000000000_0000000000000001",
          settlements: [
            {
              submissionId: "submission-1",
              outcome: "completed",
              result: { text: "read-only summary" },
            },
          ],
        },
        "submission-1",
      ),
    ).toEqual({
      state: "completed",
      summary: "read-only summary",
      offset: "0000000000000000_0000000000000001",
    });
  });
});
