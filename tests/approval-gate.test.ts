import { describe, it, expect, vi } from "vitest";
import { requireApproval } from "../src/approval";

describe("requireApproval gate", () => {
  it("hardline command is blocked, regardless of mode", async () => {
    const result = await requireApproval(
      {},
      { type: "exec", title: "danger", command: "rm -rf /" },
      { mode: "manual", sessionId: "s1" },
    );
    expect(result.denied).toBe(true);
    expect(result.decision).toBe("hardline_blocked");
    expect(result.id).toMatch(/^hardline_approval_/);
  });

  it("mode 'off' auto-approves any payload", async () => {
    const result = await requireApproval(
      {},
      { type: "exec", title: "ls", command: "ls -la" },
      { mode: "off", sessionId: "s1" },
    );
    expect(result.denied).toBe(false);
    expect(result.decision).toBe("auto_approved");
    expect(result.id).toMatch(/^approval_/);
  });

  it("mode 'smart' auto-approves safe commands without DO", async () => {
    const result = await requireApproval(
      {},
      { type: "exec", title: "ls", command: "ls -la" },
      { mode: "smart", sessionId: "s1" },
    );
    expect(result.denied).toBe(false);
    expect(result.decision).toBe("auto_approved");
  });

  it("mode 'smart' flags risky commands and registers them with the pattern in the DO", async () => {
    const { doBinding, requests } = mockApprovalDO();
    const result = await requireApproval(
      {},
      { type: "exec", title: "danger", command: "chmod 777 /tmp/foo" },
      { mode: "smart", sessionId: "s2", approvalDOBinding: doBinding },
    );
    expect(requests.length).toBe(1);
    expect(requests[0]!.pattern).toBeTruthy();
    // ws-wait upgrade fails in mock → gate resolves as timeout (denied)
    expect(result.denied).toBe(true);
    expect(result.decision).toBe("timeout");
  });

  it("manual mode registers pending approval in DO with full payload shape", async () => {
    const { doBinding, requests } = mockApprovalDO();
    await requireApproval(
      {},
      {
        type: "git_push",
        title: "Push hermes/dock",
        diff: "+1 -0",
        metadata: { branch: "hermes/dock" },
      },
      { mode: "manual", sessionId: "s3", approvalDOBinding: doBinding },
    );
    expect(requests.length).toBe(1);
    const req = requests[0]!;
    expect(req.id).toMatch(/^approval_/);
    expect(req.sessionId).toBe("s3");
    expect(req.type).toBe("git_push");
    expect(req.title).toBe("Push hermes/dock");
    expect(req.payload.diff).toBe("+1 -0");
    expect(req.payload.metadata).toEqual({ branch: "hermes/dock" });
  });

  it("uses persisted DO state when the WebSocket wake-up is unavailable", async () => {
    const { doBinding, requests, stub } = mockApprovalDO({
      status: "approved",
      decision: "once",
      decided_by: "controller",
    });
    const result = await requireApproval(
      {},
      { type: "git_push", title: "Push", diff: "+1" },
      { mode: "manual", sessionId: "s4", approvalDOBinding: doBinding },
    );

    expect(requests).toHaveLength(1);
    expect(stub.fetch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      decision: "once",
      actor: "controller",
      denied: false,
    });
  });

  it("manual mode without DO binding fails closed", async () => {
    const result = await requireApproval(
      {},
      { type: "exec", title: "x", command: "echo hi" },
      { mode: "manual", sessionId: "s5" },
    );
    expect(result.decision).toBe("timeout");
    expect(result.denied).toBe(true);
  });

  it("returns timeout decision when DO binding throws on /request", async () => {
    const stub = {
      fetch: vi.fn().mockRejectedValue(new Error("DO unreachable")),
    };
    const doBinding = {
      idFromName: vi.fn().mockReturnValue("doid"),
      get: vi.fn().mockReturnValue(stub),
    };
    const result = await requireApproval(
      {},
      { type: "git_push", title: "Push", diff: "+1" },
      { mode: "manual", sessionId: "s4", approvalDOBinding: doBinding },
    );
    expect(result.denied).toBe(true);
    expect(result.decision).toBe("timeout");
    expect(doBinding.idFromName).toHaveBeenCalledWith("approvals");
    expect(stub.fetch).toHaveBeenCalledOnce();
  });
});

/**
 * Mock ApprovalDO binding that records /request bodies and rejects the
 * ws-wait upgrade (so the gate resolves as timeout instead of hanging).
 */
function mockApprovalDO(resolvedState?: Record<string, unknown>) {
  const requests: any[] = [];
  const stub = {
    fetch: vi.fn(async (url: URL | string, init?: { body?: string }) => {
      const path = new URL(String(url), "http://do").pathname;
      if (path === "/request") {
        requests.push(JSON.parse(init?.body ?? "{}"));
        return new Response("{}", { status: 200 });
      }
      if (path === "/get" && resolvedState) {
        return Response.json(resolvedState);
      }
      // /ws-wait: no webSocket on the response → treated as upgrade failure
      return new Response(null, { status: 400 });
    }),
  };
  const doBinding = {
    idFromName: vi.fn().mockReturnValue("doid"),
    get: vi.fn().mockReturnValue(stub),
  };
  return { doBinding, requests, stub };
}
