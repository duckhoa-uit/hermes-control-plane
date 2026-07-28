import { describe, expect, it, vi } from "vitest";
import {
  getSpecialistWorkflow,
  startSpecialistWorkflow,
  type WorkflowRuntime,
} from "../src/mcp/specialist-workflows";
import { registerSpecialistWorkflowTools } from "../src/mcp/control-plan";

const env = {
  CONTROL_PLAN_INTERNAL_SECRET: "internal-secret",
} as Env;

function options(runtime: WorkflowRuntime) {
  return {
    env,
    origin: "https://control-plan.example",
    fetch: globalThis.fetch,
    runtime,
  };
}

describe("specialist workflow MCP bridge", () => {
  it("registers exactly the specialist start/poll tool surface", () => {
    const registerTool = vi.fn();
    const server = { registerTool } as never;
    registerSpecialistWorkflowTools(
      server,
      options({
        invoke: async () => ({ runId: "unused" }),
        getRun: async () => null,
      }),
    );
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual([
      "start_pr_review",
      "start_sentry_triage",
      "get_specialist_workflow",
    ]);

    const configs = Object.fromEntries(
      registerTool.mock.calls.map(([name, config]) => [name, config]),
    ) as Record<
      string,
      { description: string; annotations: Record<string, unknown>; outputSchema: unknown }
    >;
    expect(configs.start_pr_review.description).toContain("does not fetch GitHub");
    expect(configs.start_sentry_triage.description).toContain("does not query Sentry");
    expect(configs.get_specialist_workflow.description).toContain("start_pr_review");
    expect(configs.start_pr_review.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(configs.start_sentry_triage.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(configs.start_pr_review.outputSchema).toBeDefined();
    expect(configs.get_specialist_workflow.outputSchema).toBeDefined();
  });

  it("starts an allowlisted PR review with bounded input", async () => {
    let received: { workflow: unknown; request: { input: unknown } } | undefined;
    const result = await startSpecialistWorkflow(
      options({
        invoke: async (workflow, request) => {
          received = { workflow, request };
          return { runId: "run-pr-1" };
        },
        getRun: async () => null,
      }),
      "pr-review",
      {
        repository: "owner/repo",
        pullRequest: 42,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        diff: "diff --git a/src/app.ts b/src/app.ts",
      },
    );

    expect(result).toEqual({ runId: "run-pr-1" });
    expect(received?.request.input).toMatchObject({ pullRequest: 42 });
    expect(received?.workflow).toBeDefined();
  });

  it("rejects invalid snapshot input before dispatch", async () => {
    let calls = 0;
    await expect(
      startSpecialistWorkflow(
        options({
          invoke: async () => {
            calls += 1;
            return { runId: "should-not-run" };
          },
          getRun: async () => null,
        }),
        "sentry-triage",
        { organization: "org" },
      ),
    ).rejects.toThrow("Invalid sentry-triage workflow input");
    expect(calls).toBe(0);
  });

  it("reads only allowlisted specialist runs through ambient Flue inspection", async () => {
    const run = await getSpecialistWorkflow(
      options({
        invoke: async () => ({ runId: "unused" }),
        getRun: async () => ({
          runId: "run-sentry-1",
          workflowName: "sentry-triage",
          status: "completed",
          result: { severity: "high" },
        }),
      }),
      "run-sentry-1",
    );

    expect(run).toMatchObject({
      runId: "run-sentry-1",
      workflow: "sentry-triage",
      status: "completed",
      terminal: true,
      nextAction: "report",
      result: { severity: "high" },
    });
  });

  it("does not expose coding-task runs through the specialist poller", async () => {
    const run = await getSpecialistWorkflow(
      options({
        invoke: async () => ({ runId: "unused" }),
        getRun: async () => ({
          runId: "run-coding-1",
          workflowName: "coding-task",
          status: "completed",
          result: { outcome: "published" },
        }),
      }),
      "run-coding-1",
    );
    expect(run).toBeNull();
  });
});
