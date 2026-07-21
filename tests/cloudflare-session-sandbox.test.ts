import { describe, expect, it } from "vitest";
import {
  cloudflareSessionSandbox,
  getOrCreateSession,
} from "../src/agent/cloudflare-session-sandbox";
import { SandboxOperationUnsupportedError } from "@flue/runtime";

function fakeSession() {
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
