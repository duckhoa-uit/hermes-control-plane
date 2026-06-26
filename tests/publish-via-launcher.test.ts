// B1/B2 — launcher publishPr() chokepoint.
//
// Coverage:
//   - Builds the temp 'hermes-publish' remote with the write token in URL.
//   - Token passed via E2B commands.run({ envs }) — NEVER persisted to
//     .git/config (no `git config` command in the push chain).
//   - Cleans up the temp remote on success AND on push failure.
//   - POST /pulls happens on fresh mode; skipped on amend mode.
//   - amend mode returns the supplied amendPrUrl/amendPrNumber as-is.
//   - Surfaces typed errors per stage (connect / push / pulls_post).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { publishPr } from "../src/launcher/publish";

const commandsRun = vi.fn();
const connectMock = vi.fn();

vi.mock("e2b", () => ({
  Sandbox: {
    connect: (...args: unknown[]) => connectMock(...args),
  },
}));

beforeEach(() => {
  commandsRun.mockReset();
  connectMock.mockReset();
  connectMock.mockImplementation(async () => ({
    commands: { run: commandsRun },
  }));
  // Default: push succeeds.
  commandsRun.mockImplementation(async () => ({
    stdout: "Everything up-to-date\n__exit=0\n",
    stderr: "",
  }));
});

const baseInput = {
  sandboxId: "sbx_test",
  e2bApiKey: "e2b_key",
  writeToken: "ghp_write_yyy",
  repoUrl: "https://github.com/test/repo",
  branch: "hermes/abc1234",
  baseBranch: "main",
  title: "Hermes: do the thing",
  body: "Body body body",
  amendMode: false,
  ownerLogin: "alice",
} as const;

describe("publishPr (B1)", () => {
  it("fresh PR: pushes via temp 'hermes-publish' remote with token in URL, then opens PR via REST", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ html_url: "https://github.com/test/repo/pull/77", number: 77 }),
          { status: 201 },
        ),
      );
    const result = await publishPr({ ...baseInput });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.prUrl).toBe("https://github.com/test/repo/pull/77");
    expect(result.prNumber).toBe(77);

    // The push call shape.
    const [pushCmd, opts] = commandsRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(pushCmd).toContain("git remote add hermes-publish");
    // Token is referenced via $GITHUB_WRITE_TOKEN — passed as env,
    // never inlined into the command string itself.
    expect(pushCmd).toContain("$GITHUB_WRITE_TOKEN");
    expect(pushCmd).not.toContain(baseInput.writeToken);
    // Push to HEAD:<branch>; chain ends by removing the temp remote so a
    // failed push still doesn't leave a token-bearing remote behind.
    expect(pushCmd).toContain('"HEAD:hermes/abc1234"');
    expect(pushCmd.lastIndexOf("git remote remove hermes-publish")).toBeGreaterThan(
      pushCmd.indexOf("git remote add hermes-publish"),
    );

    // Env is passed via commands.run options.
    expect((opts.envs as Record<string, string>).GITHUB_WRITE_TOKEN).toBe(baseInput.writeToken);

    // The chain MUST NOT touch .git/config (would persist the token).
    expect(pushCmd).not.toContain("git config");

    // The REST POST has the right shape.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/test/repo/pulls");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_write_yyy");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      title: "Hermes: do the thing",
      head: "hermes/abc1234",
      base: "main",
      body: "Body body body",
    });
    fetchSpy.mockRestore();
  });

  it("amend mode: skips REST POST and returns the supplied PR url/number as-is", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await publishPr({
      ...baseInput,
      amendMode: true,
      amendPrNumber: 42,
      amendPrUrl: "https://github.com/test/repo/pull/42",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.amendMode).toBe(true);
    expect(result.prUrl).toBe("https://github.com/test/repo/pull/42");
    expect(result.prNumber).toBe(42);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("push failure: returns typed error with stage='push' and detail tail", async () => {
    commandsRun.mockImplementationOnce(async () => ({
      stdout:
        "remote: Permission to test/repo.git denied to alice.\n" +
        "fatal: unable to access 'https://github.com/test/repo.git': The requested URL returned error: 403\n" +
        "__exit=128\n",
      stderr: "",
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await publishPr({ ...baseInput });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.stage).toBe("push");
    expect(result.message).toContain("128");
    expect(result.detail).toContain("Permission to test/repo.git denied");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("REST POST 4xx: returns typed error with stage='pulls_post' and detail", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message: "Validation failed", errors: [{ resource: "PullRequest" }] }),
          { status: 422 },
        ),
      );
    const result = await publishPr({ ...baseInput });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.stage).toBe("pulls_post");
    expect(result.status).toBe(422);
    expect(result.detail).toContain("Validation failed");
    fetchSpy.mockRestore();
  });

  it("connect failure: returns typed error with stage='connect'", async () => {
    connectMock.mockImplementationOnce(async () => {
      throw new Error("sandbox 404");
    });
    const result = await publishPr({ ...baseInput });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.stage).toBe("connect");
    expect(result.message).toContain("sandbox 404");
  });
});
