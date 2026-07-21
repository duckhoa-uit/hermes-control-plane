import { afterEach, describe, expect, it, vi } from "vitest";
import { signScopedToken } from "../src/core/auth";

const octokitState = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock("jose", () => ({
  importPKCS8: vi.fn(async () => ({})),
  SignJWT: class {
    setProtectedHeader() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    setIssuer() {
      return this;
    }
    sign() {
      return Promise.resolve("test-app-jwt");
    }
  },
}));

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(() => ({
    rest: {
      pulls: {
        list: octokitState.list,
        create: octokitState.create,
      },
    },
  })),
}));

describe("create-pr proxy", () => {
  const taskId = `task_${"a".repeat(32)}`;
  const sessionId = `control-plan-${taskId}`;

  function taskBinding(baseBranch = "main") {
    const task = {
      id: taskId,
      sessionId,
      repository: "owner/repo",
      baseBranch,
      branch: "codex/test",
      task: "test",
      state: "dispatched",
      createdAt: 0,
      updatedAt: 0,
      replayUrl: "",
    };
    return {
      idFromName: () => "task-do",
      get: () => ({
        get: async () => task,
        beginPublication: async (ownerSessionId: string) => ({
          claimed: true,
          task: { ...task, state: "publishing", publicationSessionId: ownerSessionId },
        }),
      }),
    };
  }

  afterEach(() => {
    octokitState.list.mockReset();
    octokitState.create.mockReset();
    vi.unstubAllGlobals();
  });

  function appEnv(secret: string, binding = taskBinding()) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method || "GET") === "POST") {
          return Response.json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
        }
        return Response.json({ id: 123 });
      }),
    );
    return {
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "test-key",
      GITHUB_WEBHOOK_SECRET: secret,
      CONTROL_PLAN_PROXY_SECRET: secret,
      CONTROL_PLAN_TASK_DO: binding,
    } as unknown as Env;
  }

  it("returns an existing open PR for the same branch/base instead of creating a duplicate", async () => {
    const { default: app } = await import("../src/app");
    const secret = "test-secret";
    octokitState.list.mockResolvedValueOnce({
      data: [{ html_url: "https://github.com/o/r/pull/7", number: 7 }],
    });

    const res = await app.fetch(
      new Request("http://localhost/proxy/create-pr", {
        method: "POST",
        headers: {
          "X-Control-Plan-Session-Id": sessionId,
          Authorization: `Bearer ${await signScopedToken(secret, "proxy", sessionId, 60_000)}`,
        },
        body: JSON.stringify({
          title: "Test PR",
          body: "body",
          branch: "codex/test",
          baseBranch: "main",
        }),
      }),
      appEnv(secret),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
      existing: true,
    });
    expect(octokitState.create).not.toHaveBeenCalled();
  });

  it("creates a PR when no existing open PR matches", async () => {
    const { default: app } = await import("../src/app");
    const secret = "test-secret";
    octokitState.list.mockResolvedValueOnce({ data: [] });
    octokitState.create.mockResolvedValueOnce({
      data: { html_url: "https://github.com/o/r/pull/8", number: 8 },
    });

    const res = await app.fetch(
      new Request("http://localhost/proxy/create-pr", {
        method: "POST",
        headers: {
          "X-Control-Plan-Session-Id": sessionId,
          Authorization: `Bearer ${await signScopedToken(secret, "proxy", sessionId, 60_000)}`,
        },
        body: JSON.stringify({
          title: "Test PR",
          body: "body",
          branch: "codex/test",
          baseBranch: "main",
        }),
      }),
      appEnv(secret),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      prUrl: "https://github.com/o/r/pull/8",
      prNumber: 8,
      existing: false,
    });
    expect(octokitState.create).toHaveBeenCalledOnce();
  });

  it("uses the task base branch when the proxy request omits it", async () => {
    const { default: app } = await import("../src/app");
    const secret = "test-secret";
    octokitState.list.mockResolvedValueOnce({ data: [] });
    octokitState.create.mockResolvedValueOnce({
      data: { html_url: "https://github.com/o/r/pull/9", number: 9 },
    });

    const res = await app.fetch(
      new Request("http://localhost/proxy/create-pr", {
        method: "POST",
        headers: {
          "X-Control-Plan-Session-Id": sessionId,
          Authorization: `Bearer ${await signScopedToken(secret, "proxy", sessionId, 60_000)}`,
        },
        body: JSON.stringify({ title: "Trunk PR", body: "body", branch: "codex/test" }),
      }),
      appEnv(secret, taskBinding("trunk")),
    );

    expect(res.status).toBe(200);
    expect(octokitState.list).toHaveBeenCalledWith(
      expect.objectContaining({ base: "trunk", head: "owner:codex/test" }),
    );
    expect(octokitState.create).toHaveBeenCalledWith(expect.objectContaining({ base: "trunk" }));
  });

  it("rejects calls without a control-plane signature", async () => {
    const { default: app } = await import("../src/app");
    const res = await app.fetch(
      new Request("http://localhost/proxy/create-pr", {
        method: "POST",
        body: JSON.stringify({ title: "Test PR", branch: "codex/test" }),
      }),
      { GITHUB_WEBHOOK_SECRET: "test-secret" } as Env,
    );

    expect(res.status).toBe(401);
    expect(octokitState.list).not.toHaveBeenCalled();
  });

  it("fails closed when a signed session is not bound to a task", async () => {
    const { default: app } = await import("../src/app");
    const secret = "test-secret";
    const unboundSession = `control-plan-task_${"b".repeat(32)}`;
    const res = await app.fetch(
      new Request("http://localhost/proxy/create-pr", {
        method: "POST",
        headers: {
          "X-Control-Plan-Session-Id": unboundSession,
          Authorization: `Bearer ${await signScopedToken(secret, "proxy", unboundSession, 60_000)}`,
        },
        body: JSON.stringify({ title: "Test PR", branch: "codex/test" }),
      }),
      { GITHUB_WEBHOOK_SECRET: secret, CONTROL_PLAN_PROXY_SECRET: secret } as unknown as Env,
    );

    expect(res.status).toBe(409);
    expect(octokitState.list).not.toHaveBeenCalled();
  });
});
