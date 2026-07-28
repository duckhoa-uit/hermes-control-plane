import { afterEach, describe, expect, it, vi } from "vitest";

const pulls = vi.hoisted(() => ({
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
  Octokit: vi.fn(() => ({ rest: { pulls } })),
}));

import { PublicationService } from "../src/agent/publication-service";

describe("PublicationService", () => {
  afterEach(() => {
    pulls.list.mockReset();
    pulls.create.mockReset();
    vi.unstubAllGlobals();
  });

  it("publishes through the internal service without a Worker self-fetch", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(String(input));
        if ((init?.method || "GET") === "POST") {
          return Response.json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
        }
        return Response.json({ id: 123 });
      }),
    );
    pulls.list.mockResolvedValueOnce({ data: [] });
    pulls.create.mockResolvedValueOnce({
      data: { html_url: "https://github.com/owner/repo/pull/1", number: 1 },
    });

    const taskId = `task_${"a".repeat(32)}`;
    const sessionId = `control-plan-${taskId}`;
    const task = {
      id: taskId,
      sessionId,
      repository: "owner/repo",
      baseBranch: "main",
      branch: "control-plan/aaaaaaaaaaaaaaaa",
      task: "test",
      state: "dispatched" as const,
      createdAt: 0,
      updatedAt: 0,
      replayUrl: "",
    };
    const result = await new PublicationService({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "test-key",
    } as Env).createPullRequest(
      { title: "Test", branch: task.branch, baseBranch: task.baseBranch },
      {
        sessionId,
        taskAccess: {
          get: async () => task,
          beginPublication: async () => ({
            claimed: true,
            task: { ...task, state: "publishing" as const },
          }),
        },
      },
    );

    expect(result).toMatchObject({ success: true, prNumber: 1, existing: false });
    expect(requests.every((url) => url.startsWith("https://api.github.com/"))).toBe(true);
    expect(requests.some((url) => url.includes("/proxy/"))).toBe(false);
  });
});
