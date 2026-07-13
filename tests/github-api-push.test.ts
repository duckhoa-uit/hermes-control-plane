import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  isPushManifest,
  pushManifestWithGitHubApi,
  type PushManifest,
} from "../src/agent/github-api-push";

const BASE_SHA = "a".repeat(40);
const BASE_TREE_SHA = "b".repeat(40);

function createFakeOctokit(options: { refExists?: boolean; equivalent?: boolean } = {}) {
  const calls: Array<{ name: string; args: any }> = [];
  let refSha = options.refExists ? "old-ref" : "";

  return {
    calls,
    client: {
      rest: {
        git: {
          createBlob: async (args: any) => {
            calls.push({ name: "createBlob", args });
            return { data: { sha: `blob-${calls.filter((c) => c.name === "createBlob").length}` } };
          },
          createTree: async (args: any) => {
            calls.push({ name: "createTree", args });
            return { data: { sha: "tree-1" } };
          },
          createCommit: async (args: any) => {
            calls.push({ name: "createCommit", args });
            return { data: { sha: "commit-1" } };
          },
          getRef: async (args: any) => {
            calls.push({ name: "getRef", args });
            if (args.ref === "heads/main") return { data: { object: { sha: BASE_SHA } } };
            if (!refSha) throw { status: 404 };
            return { data: { object: { sha: refSha } } };
          },
          getCommit: async (args: any) => {
            calls.push({ name: "getCommit", args });
            return {
              data: {
                message:
                  args.commit_sha === BASE_SHA
                    ? "base"
                    : options.equivalent
                      ? "fix: update"
                      : "previous commit",
                tree: {
                  sha:
                    args.commit_sha === BASE_SHA
                      ? BASE_TREE_SHA
                      : options.equivalent
                        ? "tree-1"
                        : "old-tree",
                },
              },
            };
          },
          createRef: async (args: any) => {
            calls.push({ name: "createRef", args });
            refSha = args.sha;
            return {};
          },
          updateRef: async (args: any) => {
            calls.push({ name: "updateRef", args });
            refSha = args.sha;
            return {};
          },
        },
      },
    },
  };
}

describe("pushManifestWithGitHubApi", () => {
  it("creates blobs, tree, commit, and a missing branch ref", async () => {
    const fake = createFakeOctokit();
    const manifest: PushManifest = {
      branch: "codex/test",
      baseSha: BASE_SHA,
      baseTreeSha: BASE_TREE_SHA,
      commitMessage: "fix: update files",
      changes: [
        {
          action: "upsert",
          path: "src/a.ts",
          mode: "100644",
          contentBase64: Buffer.from("hello").toString("base64"),
        },
        { action: "delete", path: "old.txt" },
      ],
    };

    const result = await pushManifestWithGitHubApi(fake.client, "owner", "repo", manifest);

    expect(result).toEqual({
      branch: "codex/test",
      sha: "commit-1",
      created: true,
      verified: true,
      idempotent: false,
    });
    expect(fake.calls.map((call) => call.name)).toEqual([
      "getRef",
      "getRef",
      "getCommit",
      "createBlob",
      "createTree",
      "createCommit",
      "createRef",
      "getRef",
    ]);
    expect(fake.calls.find((call) => call.name === "createTree")?.args).toMatchObject({
      base_tree: BASE_TREE_SHA,
      tree: [
        { path: "src/a.ts", mode: "100644", type: "blob", sha: "blob-1" },
        { path: "old.txt", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(fake.calls.find((call) => call.name === "createCommit")?.args).toMatchObject({
      message: "fix: update files",
      tree: "tree-1",
      parents: [BASE_SHA],
    });
    expect(fake.calls.find((call) => call.name === "createRef")?.args).toMatchObject({
      ref: "refs/heads/codex/test",
      sha: "commit-1",
    });
  });

  it("updates an existing branch ref without force by default", async () => {
    const fake = createFakeOctokit({ refExists: true });
    await pushManifestWithGitHubApi(fake.client, "owner", "repo", {
      branch: "codex/existing",
      baseSha: BASE_SHA,
      baseTreeSha: BASE_TREE_SHA,
      commitMessage: "fix: update",
      changes: [
        {
          action: "upsert",
          path: "README.md",
          mode: "100644",
          contentBase64: Buffer.from("updated").toString("base64"),
        },
      ],
    });

    expect(fake.calls.find((call) => call.name === "updateRef")?.args).toMatchObject({
      ref: "heads/codex/existing",
      sha: "commit-1",
      force: false,
    });
    expect(fake.calls.find((call) => call.name === "createCommit")?.args).toMatchObject({
      parents: ["old-ref"],
    });
  });

  it("returns the existing branch head when a retry has the same tree and message", async () => {
    const fake = createFakeOctokit({ refExists: true, equivalent: true });

    const result = await pushManifestWithGitHubApi(fake.client, "owner", "repo", {
      branch: "codex/existing",
      baseSha: BASE_SHA,
      baseTreeSha: BASE_TREE_SHA,
      commitMessage: "fix: update",
      changes: [
        {
          action: "upsert",
          path: "README.md",
          mode: "100644",
          contentBase64: Buffer.from("updated").toString("base64"),
        },
      ],
    });

    expect(result).toEqual({
      branch: "codex/existing",
      sha: "old-ref",
      created: false,
      verified: true,
      idempotent: true,
    });
    expect(fake.calls.some((call) => call.name === "createCommit")).toBe(false);
    expect(fake.calls.some((call) => call.name === "updateRef")).toBe(false);
  });
});

describe("push manifest validation", () => {
  it("accepts the manifest payload and rejects the old headSha-only payload", () => {
    expect(
      isPushManifest({
        branch: "codex/test",
        baseSha: BASE_SHA,
        baseTreeSha: BASE_TREE_SHA,
        commitMessage: "fix",
        changes: [{ action: "delete", path: "old.txt" }],
      }),
    ).toBe(true);

    expect(isPushManifest({ branch: "codex/test", headSha: "abc123" })).toBe(false);
  });

  it("keeps GitHub write credentials out of the agent sandbox path", () => {
    const agent = fs.readFileSync(
      path.join(__dirname, "..", "src", "agents", "control-plan.ts"),
      "utf8",
    );

    expect(agent).not.toContain("GITHUB_WRITE_TOKEN");
    expect(agent).not.toContain("GITHUB_APP_PRIVATE_KEY");
    expect(agent).not.toContain("authUrl");
    expect(agent).not.toContain("git remote set-url origin");
    expect(agent).not.toContain("git -c http.version=HTTP/1.1 push");
  });

  it("rejects path traversal and oversized files", () => {
    expect(
      isPushManifest({
        branch: "codex/test",
        baseSha: BASE_SHA,
        baseTreeSha: BASE_TREE_SHA,
        commitMessage: "fix",
        changes: [{ action: "delete", path: "../secret" }],
      }),
    ).toBe(false);
    expect(
      isPushManifest({
        branch: "codex/test",
        baseSha: BASE_SHA,
        baseTreeSha: BASE_TREE_SHA,
        commitMessage: "fix",
        changes: [
          {
            action: "upsert",
            path: "large.bin",
            mode: "100644",
            contentBase64: "A".repeat(6_000_000),
          },
        ],
      }),
    ).toBe(false);
  });
});
