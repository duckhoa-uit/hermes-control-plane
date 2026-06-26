// Pure helpers used by src/runner/supervisor.ts. Pulled out so they can
// be unit-tested without spawning real child processes.

import type { ChildProcess } from "child_process";

/** Babysit two child processes. When either exits, kill the other and
 *  call onExit with the first exit code. Hard-kills the peer after 3 s
 *  if it has not exited on its own. Idempotent: subsequent exits are
 *  ignored. */
export function babysitForTests(
  a: ChildProcess,
  b: ChildProcess,
  onExit: (code: number | null) => void,
  hardKillAfterMs: number = 3000,
): void {
  let firstChildFired = false;
  let exitCalled = false;
  const callExit = (code: number | null) => {
    if (exitCalled) return;
    exitCalled = true;
    onExit(code);
  };
  const onChildExit = (peer: ChildProcess, code: number | null, sig: NodeJS.Signals | null) => {
    if (firstChildFired) return;
    firstChildFired = true;
    const resolvedCode = code ?? (sig ? 130 : 1);
    try {
      peer.kill("SIGTERM");
    } catch {}
    const hard = setTimeout(() => {
      try {
        peer.kill("SIGKILL");
      } catch {}
      callExit(resolvedCode);
    }, hardKillAfterMs);
    peer.on("exit", () => {
      clearTimeout(hard);
      callExit(resolvedCode);
    });
  };
  a.on("exit", (c, s) => onChildExit(b, c, s));
  b.on("exit", (c, s) => onChildExit(a, c, s));
}

/** Issue PUT /auth/{providerID} against the local opencode serve. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export async function applyZaiAuthForTests(
  baseUrl: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<void> {
  const url = `${baseUrl}/auth/zai-coding-plan`;
  const resp = await fetchImpl(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "api", key: apiKey }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "<no body>");
    throw new Error(`auth.set failed: HTTP ${resp.status}: ${body}`);
  }
}
