import { describe, expect, it, vi } from "vitest";
import { getSpecialistWorkflow, startSpecialistWorkflow } from "../src/mcp/specialist-workflows";
import { registerSpecialistWorkflowTools } from "../src/mcp/control-plan";

const env = {
  CONTROL_PLAN_INTERNAL_SECRET: "internal-secret",
} as Env;

function options(fetch: typeof globalThis.fetch) {
  return {
    env,
    origin: "https://control-plan.example",
    fetch,
  };
}

describe("specialist workflow MCP bridge", () => {
  it("registers exactly the specialist start/poll tool surface", () => {
    const registerTool = vi.fn();
    const server = { registerTool } as never;
    registerSpecialistWorkflowTools(
      server,
      options(async () => Response.json({})),
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
    const requests: Request[] = [];
    const result = await startSpecialistWorkflow(
      options(async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ runId: "run-pr-1" });
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
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe("/workflows/pr-review");
    expect(await requests[0].json()).toMatchObject({ pullRequest: 42 });
    expect(requests[0].headers.get("Authorization")).toMatch(/^Bearer /);
  });

  it("rejects invalid snapshot input before dispatch", async () => {
    let calls = 0;
    await expect(
      startSpecialistWorkflow(
        options(async () => {
          calls += 1;
          return Response.json({ runId: "should-not-run" });
        }),
        "sentry-triage",
        { organization: "org" },
      ),
    ).rejects.toThrow("Invalid sentry-triage workflow input");
    expect(calls).toBe(0);
  });

  it("reads only specialist runs and tries the workflow-scoped route token", async () => {
    const requests: Request[] = [];
    const run = await getSpecialistWorkflow(
      options(async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (requests.length === 1) return new Response("forbidden", { status: 401 });
        return Response.json({
          runId: "run-sentry-1",
          workflowName: "sentry-triage",
          status: "completed",
          result: { severity: "high" },
        });
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
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0].url).search).toBe("?meta");
    expect(new URL(requests[1].url).search).toBe("?meta");
    expect(requests[0].headers.get("Authorization")).not.toBe(
      requests[1].headers.get("Authorization"),
    );
  });

  it("does not expose coding-task runs through the specialist poller", async () => {
    const run = await getSpecialistWorkflow(
      options(async () =>
        Response.json({
          runId: "run-coding-1",
          workflowName: "coding-task",
          status: "completed",
          result: { outcome: "published" },
        }),
      ),
      "run-coding-1",
    );
    expect(run).toBeNull();
  });
});
