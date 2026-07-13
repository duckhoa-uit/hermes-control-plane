import { beforeEach, describe, expect, it, vi } from "vitest";

const octokitState = vi.hoisted(() => ({
  repo: vi.fn(),
  ref: vi.fn(),
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
      return Promise.resolve("app-jwt");
    }
  },
}));

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(() => ({
    rest: {
      repos: { get: octokitState.repo },
      git: { getRef: octokitState.ref },
    },
  })),
}));

import { GitHubApp, normalizePrivateKey } from "../src/agent/github-app";

const env = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "test-key",
} as Env;

function githubFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/installation") && (init?.method || "GET") === "GET") {
      return Response.json({ id: 456 });
    }
    if (url.includes("/access_tokens") && init?.method === "POST") {
      return Response.json({
        token: "installation-token",
        expires_at: "2099-01-01T00:00:00Z",
      });
    }
    return Response.json({ message: "unexpected request" }, { status: 500 });
  });
}

describe("GitHub App repository authorization", () => {
  beforeEach(() => {
    octokitState.repo.mockReset();
    octokitState.ref.mockReset();
  });

  it("resolves a repository default branch and scopes the read token", async () => {
    octokitState.repo.mockResolvedValue({ data: { default_branch: "trunk" } });
    octokitState.ref.mockResolvedValue({ data: { object: { sha: "abc" } } });
    const fetchImpl = githubFetch();
    const authorized = await new GitHubApp(env, fetchImpl).authorizeRepository("owner/repo");

    expect(authorized.baseBranch).toBe("trunk");
    expect(authorized.defaultBranch).toBe("trunk");
    expect(authorized.installationId).toBe(456);
    expect(octokitState.ref).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: "heads/trunk",
    });
    const tokenRequest = fetchImpl.mock.calls.find(([input]) =>
      String(input).includes("access_tokens"),
    );
    expect(JSON.parse(String(tokenRequest?.[1]?.body))).toEqual({
      repositories: ["repo"],
      permissions: { contents: "read" },
    });
  });

  it("verifies an explicitly requested branch and requests write permissions", async () => {
    octokitState.repo.mockResolvedValue({ data: { default_branch: "main" } });
    octokitState.ref.mockResolvedValue({ data: { object: { sha: "abc" } } });
    const fetchImpl = githubFetch();
    const app = new GitHubApp(env, fetchImpl);
    const authorized = await app.authorizeRepository("owner/another-repo", "develop");
    await app.getRepositoryAccess("owner/another-repo", "write");

    expect(authorized.baseBranch).toBe("develop");
    expect(octokitState.ref).toHaveBeenCalledWith({
      owner: "owner",
      repo: "another-repo",
      ref: "heads/develop",
    });
    const tokenRequest = fetchImpl.mock.calls.find(
      ([input, init]) =>
        String(input).includes("access_tokens") &&
        JSON.parse(String(init?.body)).permissions?.pull_requests === "write",
    );
    expect(JSON.parse(String(tokenRequest?.[1]?.body))).toEqual({
      repositories: ["another-repo"],
      permissions: { contents: "write", pull_requests: "write" },
    });
  });

  it("fails closed when the App is not installed", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ message: "Not Found" }, { status: 404 }));
    await expect(
      new GitHubApp(env, fetchImpl).getRepositoryAccess("owner/missing", "read"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("fails closed when App credentials are missing", async () => {
    await expect(
      new GitHubApp({} as Env, githubFetch()).getRepositoryAccess("owner/repo-without-app", "read"),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("rejects a requested branch that is not present", async () => {
    octokitState.repo.mockResolvedValue({ data: { default_branch: "main" } });
    octokitState.ref.mockRejectedValue({ status: 404 });
    await expect(
      new GitHubApp(env, githubFetch()).authorizeRepository("owner/no-branch", "release"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("converts GitHub's RSA PKCS#1 PEM into Web Crypto PKCS#8 PEM", () => {
    const normalized = normalizePrivateKey(
      "-----BEGIN RSA PRIVATE KEY-----\nMAE=\n-----END RSA PRIVATE KEY-----",
    );
    expect(normalized).toMatch(/^-----BEGIN PRIVATE KEY-----\n.+\n-----END PRIVATE KEY-----$/);
  });
});
