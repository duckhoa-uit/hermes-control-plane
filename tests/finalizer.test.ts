import { describe, expect, it, vi } from "vitest";
import {
  buildCommitCommand,
  assertWorkspaceRepository,
  runDeterministicFinalize,
  type FinalizeCheckpoint,
  type FinalizeRequest,
  type FinalizeSnapshot,
} from "../src/agent/finalizer";
import { WatchdogTimeoutError, withTimeout } from "../src/agent/watchdog";

describe("deterministic finalizer", () => {
  it("builds a simple git commit command without heredoc or command substitution", () => {
    const command = buildCommitCommand(
      "/workspace/repo",
      "Preserve focus and selection during clipboard fallback",
      "Control Plan",
      "control-plan-bot@users.noreply.github.com",
    );

    expect(command).toContain("git add -A");
    expect(command).toContain(
      "git commit -m 'Preserve focus and selection during clipboard fallback'",
    );
    expect(command).not.toContain("cat <<");
    expect(command).not.toContain("$(");
    expect(command).not.toContain("EOF");
  });

  it("quotes commit messages safely", () => {
    const command = buildCommitCommand(
      "/workspace/repo",
      "fix user's clipboard",
      "Control Plan",
      "control-plan-bot@users.noreply.github.com",
    );

    expect(command).toContain("git commit -m 'fix user'\\''s clipboard'");
  });

  it("rejects a workspace whose origin does not match the task repository", async () => {
    const exec = vi.fn(async () => ({
      stdout: "https://github.com/other/repo.git\n",
      exitCode: 0,
    }));
    await expect(
      assertWorkspaceRepository({ exec }, "/workspace/repo", "owner/repo"),
    ).rejects.toThrow("does not match task repository owner/repo");
  });

  it("normalizes a token-authenticated GitHub remote", async () => {
    const exec = vi.fn(async () => ({
      stdout: "https://x-access-token@github.com/owner/repo.git\n",
      exitCode: 0,
    }));
    await expect(
      assertWorkspaceRepository({ exec }, "/workspace/repo", "owner/repo"),
    ).resolves.toBeUndefined();
  });
});

describe("watchdog timeout", () => {
  it("rejects stuck operations", async () => {
    vi.useFakeTimers();
    try {
      const promise = withTimeout(new Promise(() => {}), 1000, "model turn");
      const rejection = expect(promise).rejects.toBeInstanceOf(WatchdogTimeoutError);

      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the native sandbox deadline without an unserializable AbortSignal", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const { execSandboxChecked } = await import("../src/agent/finalizer");

    await execSandboxChecked({ exec }, "git status", "inspect workspace", 5_000);

    expect(exec).toHaveBeenCalledWith("git status", { timeout: 5_000 });
  });
});

const request: FinalizeRequest = {
  repository: "owner/repo",
  branch: "codex/test",
  commitMessage: "fix: clipboard fallback",
  prTitle: "Fix clipboard fallback",
  prBody: "Preserve focus and selection.",
  baseBranch: "main",
  createPr: true,
  force: false,
};

const snapshot: FinalizeSnapshot = {
  ...request,
  baseSha: "a".repeat(40),
  baseTreeSha: "b".repeat(40),
  changes: [{ action: "delete", path: "old.txt" }],
  headSha: "c".repeat(40),
  repoPath: "/workspace/repo",
  manifestKB: 1,
};

describe("finalize checkpoint recovery", () => {
  it("persists each phase and completes a fresh finalize", async () => {
    const saved: FinalizeCheckpoint[] = [];
    const approvePush = vi.fn(async () => {});
    const push = vi.fn(async () => ({ sha: "remote-sha" }));
    const createPr = vi.fn(async () => ({ prNumber: 7 }));

    const result = await runDeterministicFinalize(request, {
      loadCheckpoint: async () => null,
      saveCheckpoint: async (checkpoint) => {
        saved.push(structuredClone(checkpoint));
      },
      prepare: async () => snapshot,
      approvePush,
      push,
      createPr,
    });

    expect(saved.map((checkpoint) => checkpoint.phase)).toEqual([
      "prepared",
      "pushed",
      "completed",
    ]);
    expect(approvePush).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
    expect(createPr).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      push: { sha: "remote-sha" },
      pr: { prNumber: 7 },
      recovered: false,
    });
  });

  it("resumes after push without re-preparing or pushing", async () => {
    const prepare = vi.fn(async () => snapshot);
    const approvePush = vi.fn(async () => {});
    const push = vi.fn(async () => ({ sha: "duplicate" }));
    const saved: FinalizeCheckpoint[] = [];

    const result = await runDeterministicFinalize(request, {
      loadCheckpoint: async () => ({
        request,
        phase: "pushed",
        snapshot,
        push: { sha: "remote-sha" },
      }),
      saveCheckpoint: async (checkpoint) => {
        saved.push(structuredClone(checkpoint));
      },
      prepare,
      approvePush,
      push,
      createPr: async () => ({ prNumber: 7, existing: true }),
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(approvePush).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(saved.map((checkpoint) => checkpoint.phase)).toEqual(["completed"]);
    expect(result.recovered).toBe(true);
    expect(result.push).toEqual({ sha: "remote-sha" });
  });

  it("returns a completed checkpoint without touching the sandbox or GitHub", async () => {
    const prepare = vi.fn(async () => snapshot);
    const push = vi.fn(async () => ({ sha: "duplicate" }));

    const result = await runDeterministicFinalize(request, {
      loadCheckpoint: async () => ({
        request,
        phase: "completed",
        snapshot,
        push: { sha: "remote-sha" },
        pr: { prNumber: 7 },
      }),
      saveCheckpoint: async () => {},
      prepare,
      approvePush: async () => {},
      push,
      createPr: async () => ({ prNumber: 8 }),
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      push: { sha: "remote-sha" },
      pr: { prNumber: 7 },
      recovered: true,
    });
  });
});
