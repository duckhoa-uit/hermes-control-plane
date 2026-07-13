import { describe, expect, it } from "vitest";
import { signScopedToken } from "../src/core/auth";

describe("production security boundaries", () => {
  it("rejects direct Flue agent prompts without an internal capability", async () => {
    const { default: app } = await import("../src/app");
    const response = await app.fetch(
      new Request(
        "http://localhost/agents/control-plan/control-plan-task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        {
          method: "POST",
          body: JSON.stringify({ message: "inject" }),
        },
      ),
      {} as Env,
    );
    expect(response.status).toBe(401);
  });

  it("cannot reuse a replay capability as a proxy write capability", async () => {
    const { default: app } = await import("../src/app");
    const sessionId = `control-plan-task_${"a".repeat(32)}`;
    const replayToken = await signScopedToken("replay-secret", "replay", sessionId, 60_000);
    const response = await app.fetch(
      new Request("http://localhost/proxy/create-pr", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${replayToken}`,
          "X-Control-Plan-Session-Id": sessionId,
        },
        body: JSON.stringify({ title: "x", branch: "control-plan/test" }),
      }),
      { CONTROL_PLAN_PROXY_SECRET: "proxy-secret" } as Env,
    );
    expect(response.status).toBe(401);
  });

  it("requires replay authorization to read approval details", async () => {
    const { default: app } = await import("../src/app");
    const approval = {
      id: "approval_test",
      session_id: "control-plan-task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "pending",
    };
    const binding = {
      idFromName: () => "approvals",
      get: () => ({
        fetch: async () => Response.json(approval),
      }),
    };
    const response = await app.fetch(new Request("http://localhost/approvals/approval_test"), {
      APPROVAL_DO: binding,
    } as unknown as Env);
    expect(response.status).toBe(401);
  });
});
