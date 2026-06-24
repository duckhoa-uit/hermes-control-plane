import { describe, it, expect, beforeEach } from "vitest";
import { MockSandboxProvider } from "../src/providers/mock";
import type { CreateSandboxInput } from "../src/core/types";

describe("mock-provider", () => {
  let provider: MockSandboxProvider;

  beforeEach(() => {
    provider = new MockSandboxProvider();
  });

  it("creates a sandbox", async () => {
    const input: CreateSandboxInput = {
      sessionId: "sess-1",
      runnerToken: "token-123",
      controlWsUrl: "ws://localhost:8787",
      repoUrl: "https://github.com/test/repo",
      branch: "main",
    };

    const handle = await provider.create(input);
    expect(handle.sandboxId).toBeTruthy();
    expect(handle.status).toBe("running");
    expect(handle.previewUrl).toContain("localhost");
  });

  it("executes commands and tracks them", async () => {
    const input: CreateSandboxInput = {
      sessionId: "sess-1",
      runnerToken: "token-123",
      controlWsUrl: "ws://localhost:8787",
      repoUrl: "https://github.com/test/repo",
      branch: "main",
    };

    const handle = await provider.create(input);
    const result = await provider.exec(handle, "echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("echo hello");

    const sbx = provider.getSandbox(handle.sandboxId);
    expect(sbx?.commands.length).toBe(1);
  });

  it("exposes ports", async () => {
    const input: CreateSandboxInput = {
      sessionId: "sess-1",
      runnerToken: "token-123",
      controlWsUrl: "ws://localhost:8787",
      repoUrl: "https://github.com/test/repo",
      branch: "main",
    };

    const handle = await provider.create(input);
    const url = await provider.exposePort(handle, 3000);
    expect(url).toContain("3000");
  });

  it("destroys sandbox", async () => {
    const input: CreateSandboxInput = {
      sessionId: "sess-1",
      runnerToken: "token-123",
      controlWsUrl: "ws://localhost:8787",
      repoUrl: "https://github.com/test/repo",
      branch: "main",
    };

    const handle = await provider.create(input);
    await provider.exec(handle, "echo test");
    await provider.destroy(handle);

    expect(provider.getSandbox(handle.sandboxId)).toBeUndefined();
  });

  it("returns error for unknown sandbox", async () => {
    const result = await provider.exec(
      { sandboxId: "unknown", status: "running" },
      "echo test",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});
