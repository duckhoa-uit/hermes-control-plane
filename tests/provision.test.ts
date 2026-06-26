// provisionSession must:
//   - call Sandbox.create with auto-pause+autoResume AND metadata.hermes_session_id
//   - clone repo + drop /opt/control-plane/start.json
//   - skip GH token mint when no creds; runner will surface the error
//   - return a kill() that's idempotent

import { describe, it, expect, vi, beforeEach } from "vitest";
import { provisionSession } from "../src/launcher/provision";

const filesWrite = vi.fn(async (_p: string, _c: string) => {});
const cmdRun = vi.fn(async (_cmd: string, _opts?: unknown) => ({
  exitCode: 0,
  stdout: "Cloning into ...\n__exit=0\n",
  stderr: "",
}));
const killMock = vi.fn(async () => {});
const createMock = vi.fn(async (_template: string, _opts: unknown) => ({
  sandboxId: "sbx_provision_1",
  getHost: (_p: number) => `host-${_p}`,
  files: { write: filesWrite },
  commands: { run: cmdRun },
  kill: killMock,
}));

vi.mock("e2b", () => ({
  Sandbox: {
    create: (...args: unknown[]) => createMock(...(args as [string, unknown])),
    connect: async (_id: string, _opts: unknown) => ({ kill: killMock }),
  },
}));

describe("provisionSession", () => {
  beforeEach(() => {
    filesWrite.mockClear();
    cmdRun.mockClear();
    killMock.mockClear();
    createMock.mockClear();
  });

  it("tags the sandbox with hermes_session_id and uses auto-pause", async () => {
    const p = await provisionSession({
      sessionId: "sess_abc",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
    });
    expect(p.sandboxId).toBe("sbx_provision_1");
    const [, opts] = createMock.mock.calls[0] as [string, Record<string, unknown>];
    const meta = opts.metadata as Record<string, string>;
    expect(meta.hermes_session_id).toBe("sess_abc");
    const lifecycle = opts.lifecycle as Record<string, unknown>;
    expect(lifecycle.onTimeout).toBe("pause");
    expect(lifecycle.autoResume).toBe(true);
  });

  it("writes /opt/control-plane/start.json with required keys", async () => {
    await provisionSession({
      sessionId: "sess_keys",
      runnerToken: "tok2",
      controlWsUrl: "wss://y",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
    });
    expect(filesWrite).toHaveBeenCalledTimes(1);
    const [path, content] = filesWrite.mock.calls[0];
    expect(path).toBe("/opt/control-plane/start.json");
    const cfg = JSON.parse(content as string);
    expect(cfg.CONTROL_PLANE_SESSION_ID).toBe("sess_keys");
    expect(cfg.CONTROL_PLANE_RUNNER_TOKEN).toBe("tok2");
    expect(cfg.CONTROL_PLANE_WS).toBe("wss://y");
  });

  it("returns an idempotent kill()", async () => {
    const p = await provisionSession({
      sessionId: "sess_kill",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
    });
    await p.kill();
    await p.kill();
    expect(killMock).toHaveBeenCalledTimes(1);
  });

  it("kills the sandbox and throws if clone fails", async () => {
    cmdRun.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "fatal: repo not found\n__exit=128\n",
      stderr: "",
    });
    await expect(
      provisionSession({
        sessionId: "sess_bad",
        runnerToken: "tok",
        controlWsUrl: "wss://x",
        repoUrl: "https://github.com/test/nope",
        e2bApiKey: "key",
        e2bTemplate: "control-plane-runner",
      }),
    ).rejects.toThrow(/git clone failed \(exit 128\)/);
    expect(killMock).toHaveBeenCalledTimes(1);
  });

  it("amend mode: fetches + checks out the PR branch (no fresh hermes/ branch)", async () => {
    await provisionSession({
      sessionId: "sess_amend",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
      githubUserToken: "ghp_x",
      githubUserLogin: "alice",
      prMode: {
        branch: "hermes/abcd1234",
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
      },
    });
    // cmdRun calls: [0]=clone, [1]=git config + fetch + checkout combo.
    const setupCall = cmdRun.mock.calls[1] as [string, unknown];
    const setupCmd = setupCall[0];
    expect(setupCmd).toContain("git fetch --depth 50 origin '+refs/heads/hermes/abcd1234:refs/remotes/origin/hermes/abcd1234'");
    expect(setupCmd).toContain("git checkout -B 'hermes/abcd1234' 'origin/hermes/abcd1234'");
    expect(setupCmd).not.toContain("hermes/ss_amend");
    // start.json must carry the amend env vars.
    const cfg = JSON.parse(filesWrite.mock.calls[0][1] as string);
    expect(cfg.CONTROL_PLANE_PR_MODE_BRANCH).toBe("hermes/abcd1234");
    expect(cfg.CONTROL_PLANE_PR_MODE_NUMBER).toBe("42");
    expect(cfg.CONTROL_PLANE_PR_MODE_URL).toBe(
      "https://github.com/test/repo/pull/42",
    );
  });

  it("fresh mode (no prMode): creates hermes/<session-tail> branch and no amend env vars", async () => {
    await provisionSession({
      sessionId: "session_12345678",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
      githubUserToken: "ghp_x",
      githubUserLogin: "alice",
    });
    const setupCmd = (cmdRun.mock.calls[1] as [string, unknown])[0] as string;
    expect(setupCmd).toContain("git checkout -B hermes/12345678");
    expect(setupCmd).not.toContain("git fetch origin");
    const cfg = JSON.parse(filesWrite.mock.calls[0][1] as string);
    expect(cfg.CONTROL_PLANE_PR_MODE_BRANCH).toBeUndefined();
    expect(cfg.CONTROL_PLANE_PR_MODE_NUMBER).toBeUndefined();
    expect(cfg.CONTROL_PLANE_PR_MODE_URL).toBeUndefined();
  });

  // PR #A / A1
  it("branchSuffix (valid): branch is hermes/<suffix>-<id4>", async () => {
    await provisionSession({
      sessionId: "session_abcdef12",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
      githubUserToken: "ghp_x",
      githubUserLogin: "alice",
      branchSuffix: "add-rate-limit-middleware",
    });
    const setupCmd = (cmdRun.mock.calls[1] as [string, unknown])[0] as string;
    expect(setupCmd).toContain("git checkout -B hermes/add-rate-limit-middleware-ef12");
  });

  // PR #A / A1
  it("branchSuffix (invalid characters): silently falls back to <id8>", async () => {
    await provisionSession({
      sessionId: "session_abcdef12",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
      githubUserToken: "ghp_x",
      githubUserLogin: "alice",
      branchSuffix: "Add Rate Limit!", // capitals + spaces + ! — invalid
    });
    const setupCmd = (cmdRun.mock.calls[1] as [string, unknown])[0] as string;
    expect(setupCmd).toContain("git checkout -B hermes/abcdef12");
    expect(setupCmd).not.toContain("add-rate-limit");
  });

  // PR #A / A1
  it("branchSuffix (>40 chars): silently falls back to <id8>", async () => {
    await provisionSession({
      sessionId: "session_abcdef12",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
      githubUserToken: "ghp_x",
      githubUserLogin: "alice",
      branchSuffix: "a".repeat(41),
    });
    const setupCmd = (cmdRun.mock.calls[1] as [string, unknown])[0] as string;
    expect(setupCmd).toContain("git checkout -B hermes/abcdef12");
  });

  // PR #A / A5
  it("amendTrigger=review_changes_requested: serialises into start.json", async () => {
    await provisionSession({
      sessionId: "session_review01",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
      githubUserToken: "ghp_x",
      githubUserLogin: "alice",
      prMode: { branch: "hermes/x", prNumber: 7, prUrl: "https://github.com/test/repo/pull/7" },
      amendTrigger: {
        kind: "review_changes_requested",
        reviewerLogin: "bob",
        reviewBody: "please address X",
      },
    });
    const cfg = JSON.parse(filesWrite.mock.calls[0][1] as string);
    expect(cfg.CONTROL_PLANE_AMEND_TRIGGER_KIND).toBe("review_changes_requested");
    const trig = JSON.parse(cfg.CONTROL_PLANE_AMEND_TRIGGER_JSON);
    expect(trig.reviewerLogin).toBe("bob");
    expect(trig.reviewBody).toBe("please address X");
  });

  // PR #A / A5
  it("amendTrigger=ci_failure: serialises into start.json", async () => {
    await provisionSession({
      sessionId: "session_ci01",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
      githubUserToken: "ghp_x",
      githubUserLogin: "alice",
      prMode: { branch: "hermes/x", prNumber: 9, prUrl: "https://github.com/test/repo/pull/9" },
      amendTrigger: {
        kind: "ci_failure",
        checkName: "e2e (ubuntu)",
        detailsUrl: "https://gh/.../runs/123",
        conclusion: "failure",
      },
    });
    const cfg = JSON.parse(filesWrite.mock.calls[0][1] as string);
    expect(cfg.CONTROL_PLANE_AMEND_TRIGGER_KIND).toBe("ci_failure");
    const trig = JSON.parse(cfg.CONTROL_PLANE_AMEND_TRIGGER_JSON);
    expect(trig.checkName).toBe("e2e (ubuntu)");
  });

  // ---- PR #B / B2-B3: publish-via-launcher token discipline ----

  it("publishViaLauncher=true: GITHUB_WRITE_TOKEN is absent from start.json", async () => {
    await provisionSession({
      sessionId: "session_b3_a",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
      githubUserToken: "ghp_write",
      githubReadToken: "ghp_read",
      githubUserLogin: "alice",
    });
    const cfg = JSON.parse(filesWrite.mock.calls[0][1] as string);
    expect(cfg.GITHUB_WRITE_TOKEN).toBeUndefined();
    expect(cfg.HERMES_PUBLISH_VIA_LAUNCHER).toBeUndefined();
  });

  it("publishViaLauncher=true: sandbox origin URL uses the READ token, not the write token", async () => {
    await provisionSession({
      sessionId: "session_b3_c",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
      githubUserToken: "ghp_writexxx",
      githubReadToken: "ghp_readyyy",
      githubUserLogin: "alice",
    });
    // First call is the clone, second is the setup chain that includes
    // `git remote set-url origin '<url>'`.  Match against the joined cmd.
    const calls = cmdRun.mock.calls.map((c) => (c[0] as string));
    const setupCmd = calls.find((c) => c.includes("git remote set-url origin"));
    expect(setupCmd).toBeDefined();
    expect(setupCmd).toContain("ghp_readyyy");
    expect(setupCmd).not.toContain("ghp_writexxx");
  });

  it("publishViaLauncher=true + readToken unset: falls back to write token (compat)", async () => {
    await provisionSession({
      sessionId: "session_b3_d",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
      githubUserToken: "ghp_write_only",
      // No githubReadToken supplied (legacy setup).
      githubUserLogin: "alice",
    });
    const calls = cmdRun.mock.calls.map((c) => (c[0] as string));
    const setupCmd = calls.find((c) => c.includes("git remote set-url origin"));
    expect(setupCmd).toBeDefined();
    expect(setupCmd).toContain("ghp_write_only");
    // Even under fallback, the write token is still stripped from start.json
    // since the runner will not use it for publish anyway.
    const cfg = JSON.parse(filesWrite.mock.calls[0][1] as string);
    expect(cfg.GITHUB_WRITE_TOKEN).toBeUndefined();
  });

  // ---- PR #A / A5: no amendTrigger means no env var (back-compat)
  it("no amendTrigger: CONTROL_PLANE_AMEND_TRIGGER_* env vars are absent", async () => {
    await provisionSession({
      sessionId: "session_amend02",
      runnerToken: "tok",
      controlWsUrl: "wss://x",
      repoUrl: "https://github.com/test/repo",
      e2bApiKey: "key",
      e2bTemplate: "control-plane-runner",
      githubUserToken: "ghp_x",
      githubUserLogin: "alice",
      prMode: { branch: "hermes/x", prNumber: 1, prUrl: "https://github.com/test/repo/pull/1" },
    });
    const cfg = JSON.parse(filesWrite.mock.calls[0][1] as string);
    expect(cfg.CONTROL_PLANE_AMEND_TRIGGER_KIND).toBeUndefined();
    expect(cfg.CONTROL_PLANE_AMEND_TRIGGER_JSON).toBeUndefined();
  });
});
