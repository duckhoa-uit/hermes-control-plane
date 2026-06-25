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
});
