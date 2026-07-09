import { afterEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../src/core/auth";

const octokitState = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
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
  afterEach(() => {
    octokitState.list.mockReset();
    octokitState.create.mockReset();
  });

  it("returns an existing open PR for the same branch/base instead of creating a duplicate", async () => {
    const { default: app } = await import("../src/app");
    const secret = "test-secret";
    const sessionId = "test-session";
    octokitState.list.mockResolvedValueOnce({
      data: [{ html_url: "https://github.com/o/r/pull/7", number: 7 }],
    });

    const res = await app.fetch(
      new Request("http://localhost/proxy/create-pr", {
        method: "POST",
        headers: {
          "X-Hermes-Session-Id": sessionId,
          Authorization: `Bearer ${await signToken(secret, sessionId)}`,
        },
        body: JSON.stringify({
          title: "Test PR",
          body: "body",
          branch: "codex/test",
          baseBranch: "main",
        }),
      }),
      {
        GITHUB_WRITE_TOKEN: "token",
        GITHUB_OWNER: "owner",
        GITHUB_REPO: "repo",
        GITHUB_WEBHOOK_SECRET: secret,
      } as Env,
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
    const sessionId = "test-session";
    octokitState.list.mockResolvedValueOnce({ data: [] });
    octokitState.create.mockResolvedValueOnce({
      data: { html_url: "https://github.com/o/r/pull/8", number: 8 },
    });

    const res = await app.fetch(
      new Request("http://localhost/proxy/create-pr", {
        method: "POST",
        headers: {
          "X-Hermes-Session-Id": sessionId,
          Authorization: `Bearer ${await signToken(secret, sessionId)}`,
        },
        body: JSON.stringify({
          title: "Test PR",
          body: "body",
          branch: "codex/test",
          baseBranch: "main",
        }),
      }),
      {
        GITHUB_WRITE_TOKEN: "token",
        GITHUB_OWNER: "owner",
        GITHUB_REPO: "repo",
        GITHUB_WEBHOOK_SECRET: secret,
      } as Env,
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
});
