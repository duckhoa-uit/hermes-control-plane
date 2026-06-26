// Orphan sandbox sweeper. Run once at sidecar startup (and optionally on a
// timer) to reclaim concurrency-cap slots from sandboxes whose session is
// already terminal in the Worker.
//
// Rules:
//   - Only consider sandboxes tagged with metadata.hermes_session_id.
//     (Sandboxes without the tag are someone else's; never touch.)
//   - For each tagged sandbox: ask the Worker for the session's status.
//     If terminal (completed/failed/aborted/archived), kill.
//     If the session is unknown (404), kill — DO state is the source of truth
//     and a sandbox tied to a vanished session is by definition orphaned.
//     Otherwise (running/needs_approval/...): leave alone.

import { killSandbox } from "./provision";

interface SweepInput {
  e2bApiKey: string;
  hermesBaseUrl: string;
}

interface SweepResult {
  scanned: number;
  killed: string[];
  kept: string[];
}

interface E2BSandbox {
  sandboxID?: string;
  state?: string;
  metadata?: Record<string, string>;
}

export async function sweepOrphans(input: SweepInput): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, killed: [], kept: [] };

  const listResp = await fetch("https://api.e2b.dev/v2/sandboxes", {
    headers: { "X-API-Key": input.e2bApiKey },
  });
  if (!listResp.ok) {
    throw new Error(`E2B list failed ${listResp.status}: ${await listResp.text()}`);
  }
  const body = (await listResp.json()) as E2BSandbox[] | { sandboxes?: E2BSandbox[] };
  const sandboxes: E2BSandbox[] = Array.isArray(body)
    ? body
    : Array.isArray(body.sandboxes)
      ? body.sandboxes
      : [];

  for (const sbx of sandboxes) {
    const id = sbx.sandboxID;
    const sessionId = sbx.metadata?.hermes_session_id;
    if (!id || !sessionId) continue;
    result.scanned++;

    let shouldKill = false;
    try {
      const r = await fetch(`${input.hermesBaseUrl}/sessions/${sessionId}`);
      if (r.status === 404) {
        shouldKill = true;
      } else if (r.ok) {
        const data = (await r.json()) as { session?: { status: string } };
        const status = data.session?.status;
        // `archived` is included so sandboxes whose session was archived
        // via a merge webhook (race vs. the watcher) still get reclaimed.
        if (status && ["completed", "failed", "aborted", "archived"].includes(status)) {
          shouldKill = true;
        }
      }
      // Worker unreachable / 5xx -> leave alone, try next time.
    } catch {
      // network error -> leave alone
    }

    if (shouldKill) {
      await killSandbox(input.e2bApiKey, id);
      result.killed.push(id);
    } else {
      result.kept.push(id);
    }
  }

  return result;
}
