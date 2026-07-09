import { describe, expect, it, vi } from "vitest";
import { withDefaultExecTimeout } from "../src/agent/sandbox-timeout";

describe("withDefaultExecTimeout", () => {
  it("adds a default timeout when the caller omits one", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0 });
    const factory = withDefaultExecTimeout(
      {
        createSessionEnv: async () => ({ exec }) as any,
      },
      1234,
    );

    const env = await factory.createSessionEnv({ id: "test" });
    await env.exec("echo hi", { cwd: "/workspace" });

    expect(exec).toHaveBeenCalledWith("echo hi", {
      cwd: "/workspace",
      timeoutMs: 1234,
    });
  });

  it("preserves explicit per-command timeout", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0 });
    const factory = withDefaultExecTimeout(
      {
        createSessionEnv: async () => ({ exec }) as any,
      },
      1234,
    );

    const env = await factory.createSessionEnv({ id: "test" });
    await env.exec("bun test", { timeoutMs: 9999 });

    expect(exec).toHaveBeenCalledWith("bun test", { timeoutMs: 9999 });
  });
});
