import { describe, it, expect } from "vitest";
import { parseRepoUrl, PrLifecycle } from "../src/agent/pr-lifecycle";

describe("parseRepoUrl", () => {
  it("parses standard HTTPS GitHub URL", () => {
    const result = parseRepoUrl("https://github.com/owner/repo");
    expect(result).toEqual({ repoOwner: "owner", repoName: "repo" });
  });

  it("parses URL with .git suffix", () => {
    const result = parseRepoUrl("https://github.com/owner/repo.git");
    expect(result).toEqual({ repoOwner: "owner", repoName: "repo" });
  });

  it("parses SSH-style git URL", () => {
    const result = parseRepoUrl("git@github.com:owner/repo.git");
    expect(result).toEqual({ repoOwner: "owner", repoName: "repo" });
  });

  it("parses URL with subpaths", () => {
    const result = parseRepoUrl("https://github.com/owner/repo/tree/main/src");
    expect(result).toEqual({ repoOwner: "owner", repoName: "repo" });
  });

  it("throws on invalid URL", () => {
    expect(() => parseRepoUrl("https://gitlab.com/owner/repo")).toThrow();
  });

  it("throws on non-URL string", () => {
    expect(() => parseRepoUrl("not-a-url")).toThrow();
  });
});

describe("PrLifecycle", () => {
  it("can be constructed", () => {
    const lifecycle = new PrLifecycle({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "test" });
    expect(lifecycle).toBeDefined();
  });

  it("pushBranch returns error with bad token", async () => {
    const lifecycle = new PrLifecycle({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "bad-token" });
    const result = await lifecycle.pushBranch("owner", "repo", "branch", "sha123", false);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("getBranchHeadSha returns null for bad token", async () => {
    const lifecycle = new PrLifecycle({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "bad-token" });
    const result = await lifecycle.getBranchHeadSha("owner", "repo", "nonexistent");
    expect(result).toBeNull();
  });
});
