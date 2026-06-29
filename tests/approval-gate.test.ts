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

  it("mode 'smart' flags risky commands and falls back to auto when no DO binding", async () => {
    const emitted: Array<{ name: string; data: any }> = [];
    const result = await requireApproval(
      {
        emitData: (name, data) => {
          emitted.push({ name, data: data as any });
        },
      },
      { type: "exec", title: "danger", command: "chmod 777 /tmp/foo" },
      { mode: "smart", sessionId: "s2" },
    );
    expect(emitted.length).toBe(1);
    expect(emitted[0]?.name).toBe("approval_requested");
    expect((emitted[0]!.data as any).pattern).toBeTruthy();
    // No DO binding → fallback to sleep + auto-approve
    expect(result.decision).toBe("auto_approved");
  });

  it("manual mode emits approval_requested event with full payload shape", async () => {
    const emitted: Array<{ name: string; data: any; opts?: any }> = [];
    const result = await requireApproval(
      {
        emitData: (name, data, opts) => {
          emitted.push({ name, data, opts });
        },
      },
      {
        type: "git_push",
        title: "Push hermes/dock",
        diff: "+1 -0",
        metadata: { branch: "hermes/dock" },
      },
      { mode: "manual", sessionId: "s3" },
    );
    expect(emitted.length).toBe(1);
    const ev = emitted[0]!;
    expect(ev.name).toBe("approval_requested");
    expect(ev.data.type).toBe("git_push");
    expect(ev.data.title).toBe("Push hermes/dock");
    expect(ev.data.diff).toBe("+1 -0");
    expect(ev.data.metadata).toEqual({ branch: "hermes/dock" });
    expect(ev.opts.id).toBe(ev.data.id);
    expect(result.decision).toBe("auto_approved"); // no DO → fallback
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
      { emitData: () => {} },
      { type: "git_push", title: "Push", diff: "+1" },
      { mode: "manual", sessionId: "s4", approvalDOBinding: doBinding },
    );
    expect(result.denied).toBe(true);
    expect(result.decision).toBe("timeout");
    expect(doBinding.idFromName).toHaveBeenCalledWith("approvals");
    expect(stub.fetch).toHaveBeenCalledOnce();
  });

  it("emitData error is swallowed and approval continues", async () => {
    const result = await requireApproval(
      {
        emitData: () => {
          throw new Error("stream closed");
        },
      },
      { type: "exec", title: "x", command: "echo hi" },
      { mode: "manual", sessionId: "s5" },
    );
    // No DO → fallback auto_approved
    expect(result.decision).toBe("auto_approved");
  });
});
