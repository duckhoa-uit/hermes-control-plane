import { describe, expect, it } from "vitest";
import {
  classifySandboxError,
  cloudflareSessionSandbox,
  getOrCreateSession,
  SandboxRecoveryCircuitOpenError,
  SandboxUnknownOutcomeError,
} from "../src/agent/cloudflare-session-sandbox";
import { SandboxOperationUnsupportedError } from "@flue/runtime";

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "flue-test",
    async exec(command: string, options?: Record<string, unknown>) {
      return { success: true, command, options, stdout: "ok", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return { content: "text" };
    },
    async writeFile() {
      return { success: true };
    },
    async exists() {
      return { exists: true };
    },
    async mkdir() {
      return { success: true };
    },
    async deleteFile() {
      return { success: true };
    },
    ...overrides,
  };
}

function sandboxFor(sessions: Array<Record<string, any>>, onCreate?: (count: number) => void) {
  let createCount = 0;
  return {
    async createSession() {
      onCreate?.(createCount);
      return sessions[Math.min(createCount++, sessions.length - 1)];
    },
    async getSession() {
      return sessions[Math.min(Math.max(createCount - 1, 0), sessions.length - 1)];
    },
  };
}

describe("cloudflareSessionSandbox", () => {
  it("creates an explicit provider session and routes Flue exec through it", async () => {
    const calls: Array<{ method: string; value?: unknown }> = [];
    const session = fakeSession();
    const sandbox = {
      async createSession(options: unknown) {
        calls.push({ method: "createSession", value: options });
        return session;
      },
      async getSession(id: string) {
        calls.push({ method: "getSession", value: id });
        return session;
      },
    };

    const env = await cloudflareSessionSandbox(sandbox as never, {
      cwd: "/workspace/lawn",
      sessionId: "flue-test",
    }).createSessionEnv({ id: "ignored-by-explicit-session" });
    const result = await env.exec("pwd", { timeoutMs: 1234 });

    expect(calls).toEqual([
      { method: "createSession", value: { id: "flue-test", cwd: "/workspace/lawn" } },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("does not send non-serializable abort signals over RPC", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const session = {
      ...fakeSession(),
      async exec(_command: string, options?: Record<string, unknown>) {
        calls.push(options);
        return { success: true, stdout: "ok", stderr: "", exitCode: 0 };
      },
    };
    const sandbox = {
      async createSession() {
        return session;
      },
      async getSession() {
        return session;
      },
    };

    const env = await cloudflareSessionSandbox(sandbox as never, {
      sessionId: "flue-test",
    }).createSessionEnv({ id: "ignored" });
    await env.exec("git status", {
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });

    expect(calls).toEqual([{ cwd: "/workspace", env: undefined, timeout: 5_000 }]);
  });

  it("reuses an existing explicit session after a retry", async () => {
    const session = fakeSession();
    const sandbox = {
      async createSession() {
        const error = new Error("already exists");
        error.name = "SessionAlreadyExistsError";
        throw error;
      },
      async getSession(id: string) {
        expect(id).toBe("flue-test");
        return session;
      },
    };

    await expect(getOrCreateSession(sandbox as never, "flue-test")).resolves.toBe(session);
  });

  it("returns provider metadata from stat without fabricating defaults", async () => {
    const session = {
      ...fakeSession(),
      async exec(command: string) {
        if (command.startsWith("stat -L")) {
          return {
            success: true,
            stdout: "12/1710000000/regular file\nsymbolic link",
            stderr: "",
            exitCode: 0,
          };
        }
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const sandbox = {
      async createSession() {
        return session;
      },
      async getSession() {
        return session;
      },
    };
    const env = await cloudflareSessionSandbox(sandbox as never, {
      sessionId: "flue-test",
    }).createSessionEnv({ id: "ignored" });

    await expect(env.stat("/workspace/link")).resolves.toMatchObject({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: true,
      size: 12,
      mtime: new Date(1710000000 * 1_000),
    });
  });

  it("reacquires the same session after a transient read reset", async () => {
    const first = fakeSession({
      async readFile() {
        throw Object.assign(new Error("storage reset"), { code: "RPC_TRANSPORT_ERROR" });
      },
    });
    const second = fakeSession({
      async readFile() {
        return { content: "recovered" };
      },
    });
    const events: unknown[] = [];
    const sandbox = sandboxFor([first, second]);
    const env = await cloudflareSessionSandbox(
      sandbox as never,
      { sessionId: "flue-test" },
      { backoffMs: 0, onRecoveryEvent: (event) => events.push(event) },
    ).createSessionEnv({ id: "ignored" });

    await expect(env.readFile("/workspace/file")).resolves.toBe("recovered");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "readFile", errorKind: "transient_reset" }),
        expect.objectContaining({ operation: "readFile", sessionReacquired: true }),
      ]),
    );
  });

  it("does not repeat an exec after an uncertain reset", async () => {
    let execCalls = 0;
    const session = fakeSession({
      async exec() {
        execCalls += 1;
        throw Object.assign(new Error("peer closed"), { code: "RPC_TRANSPORT_ERROR" });
      },
    });
    const sandbox = sandboxFor([session]);
    const env = await cloudflareSessionSandbox(
      sandbox as never,
      { sessionId: "flue-test" },
      { backoffMs: 0 },
    ).createSessionEnv({ id: "ignored" });

    await expect(env.exec("touch /workspace/file")).rejects.toBeInstanceOf(
      SandboxUnknownOutcomeError,
    );
    expect(execCalls).toBe(1);
  });

  it("verifies full replacement writes before returning success", async () => {
    let content = "";
    const session = fakeSession({
      async writeFile(_path: string, value: string) {
        content = value;
        return { success: true };
      },
      async readFile(_path: string) {
        return { content };
      },
    });
    const sandbox = sandboxFor([session]);
    const env = await cloudflareSessionSandbox(sandbox as never, {
      sessionId: "flue-test",
    }).createSessionEnv({ id: "ignored" });

    await expect(env.writeFile("/workspace/file", "hello")).resolves.toBeUndefined();
    expect(content).toBe("hello");
  });

  it("reconciles a write after a reset before retrying it", async () => {
    let content = "";
    let writes = 0;
    const first = fakeSession({
      async writeFile(_path: string, value: string) {
        writes += 1;
        content = value;
        throw Object.assign(new Error("peer closed"), { code: "RPC_TRANSPORT_ERROR" });
      },
      async readFile() {
        return { content };
      },
    });
    const second = fakeSession({
      async writeFile(_path: string, value: string) {
        writes += 1;
        content = value;
        return { success: true };
      },
      async readFile() {
        return { content };
      },
    });
    const sandbox = sandboxFor([first, second]);
    const env = await cloudflareSessionSandbox(
      sandbox as never,
      { sessionId: "flue-test" },
      { backoffMs: 0 },
    ).createSessionEnv({ id: "ignored" });

    await expect(env.writeFile("/workspace/file", "hello")).resolves.toBeUndefined();
    expect(writes).toBe(1);
  });

  it("classifies timeout, transient, terminal, and update-reset failures", () => {
    expect(classifySandboxError(new Error("request timed out"))).toMatchObject({
      kind: "timeout",
      retryable: true,
    });
    expect(classifySandboxError({ errorResponse: { context: { retryable: true } } })).toMatchObject(
      { kind: "transient_reset", retryable: true },
    );
    expect(classifySandboxError(new Error("permission denied"))).toMatchObject({
      kind: "terminal",
      retryable: false,
    });
    expect(classifySandboxError({ code: "DURABLE_OBJECT_CODE_UPDATE_RESET" })).toMatchObject({
      kind: "terminal",
      retryable: false,
    });
  });

  it("stops safe-operation recovery at the configured attempt limit", async () => {
    let reads = 0;
    const session = fakeSession({
      async readFile() {
        reads += 1;
        throw Object.assign(new Error("storage reset"), { code: "RPC_TRANSPORT_ERROR" });
      },
    });
    const sandbox = sandboxFor([session]);
    const env = await cloudflareSessionSandbox(
      sandbox as never,
      { sessionId: "flue-test" },
      { maxRecoveryAttempts: 1, backoffMs: 0 },
    ).createSessionEnv({ id: "ignored" });

    await expect(env.readFile("/workspace/file")).rejects.toThrow("storage reset");
    expect(reads).toBe(2);
  });

  it("opens the circuit after repeated recovery failures", async () => {
    const session = fakeSession({
      async readFile() {
        throw Object.assign(new Error("storage reset"), { code: "RPC_TRANSPORT_ERROR" });
      },
    });
    const sandbox = sandboxFor([session]);
    const env = await cloudflareSessionSandbox(
      sandbox as never,
      { sessionId: "flue-test" },
      {
        maxRecoveryAttempts: 0,
        circuitBreakerThreshold: 1,
        circuitBreakerCooldownMs: 10_000,
        backoffMs: 0,
      },
    ).createSessionEnv({ id: "ignored" });

    await expect(env.readFile("/workspace/one")).rejects.toThrow("storage reset");
    await expect(env.readFile("/workspace/two")).rejects.toBeInstanceOf(
      SandboxRecoveryCircuitOpenError,
    );
  });

  it("routes binary reads, directory reads, exists, and recursive mkdir", async () => {
    const calls: string[] = [];
    const session = fakeSession({
      async readFile(_path: string, options?: { encoding?: string }) {
        calls.push(`read:${options?.encoding ?? "text"}`);
        return { content: options?.encoding === "base64" ? "AQI=" : "text" };
      },
      async exec(command: string) {
        calls.push(command);
        return {
          success: true,
          stdout: command.startsWith("find") ? "one\0two\0" : "",
          stderr: "",
          exitCode: 0,
        };
      },
      async exists() {
        calls.push("exists");
        return { exists: false };
      },
      async mkdir(_path: string, options?: { recursive?: boolean }) {
        calls.push(`mkdir:${options?.recursive ? "recursive" : "single"}`);
        return { success: true };
      },
    });
    const sandbox = sandboxFor([session]);
    const env = await cloudflareSessionSandbox(sandbox as never, {
      sessionId: "flue-test",
    }).createSessionEnv({ id: "ignored" });

    await expect(env.readFileBuffer("/workspace/data")).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(env.readdir("/workspace")).resolves.toEqual(["one", "two"]);
    await expect(env.exists("/workspace/missing")).resolves.toBe(false);
    await expect(env.mkdir("/workspace/new", { recursive: true })).resolves.toBeUndefined();
    expect(calls).toEqual([
      "read:base64",
      "find '/workspace' -mindepth 1 -maxdepth 1 -printf '%f\\0'",
      "exists",
      "mkdir:recursive",
    ]);
  });

  it("does not repeat non-recursive mkdir or file deletion after a reset", async () => {
    const session = fakeSession({
      async mkdir() {
        throw Object.assign(new Error("peer closed"), { code: "RPC_TRANSPORT_ERROR" });
      },
      async deleteFile() {
        throw Object.assign(new Error("peer closed"), { code: "RPC_TRANSPORT_ERROR" });
      },
    });
    const sandbox = sandboxFor([session]);
    const env = await cloudflareSessionSandbox(sandbox as never, {
      sessionId: "flue-test",
    }).createSessionEnv({ id: "ignored" });

    await expect(env.mkdir("/workspace/new")).rejects.toBeInstanceOf(SandboxUnknownOutcomeError);
    await expect(env.rm("/workspace/file")).rejects.toBeInstanceOf(SandboxUnknownOutcomeError);
  });

  it("rejects unsupported removal flags with the Flue adapter error", async () => {
    const session = fakeSession();
    const sandbox = {
      async createSession() {
        return session;
      },
      async getSession() {
        return session;
      },
    };
    const env = await cloudflareSessionSandbox(sandbox as never, {
      sessionId: "flue-test",
    }).createSessionEnv({ id: "ignored" });

    await expect(env.rm("/workspace/repo", { recursive: true })).rejects.toBeInstanceOf(
      SandboxOperationUnsupportedError,
    );
  });
});
