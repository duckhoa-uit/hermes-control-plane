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

import {
  CircuitBreaker,
  RetryableHttpError,
  withResilience,
  type ResilienceLogger,
} from "../core/resilience";

// Module-level breaker so multiple sweeper invocations share state. If
// E2B has been flaking for the last 5 calls we don't want a fresh sweep
// to hammer it again — fail fast for 30s and reclaim slots on the next
// scheduled run.
const E2B_LIST_BREAKER = new CircuitBreaker({
  name: "e2b.list",
  failureThreshold: 5,
  coolDownMs: 30_000,
});

interface SweepInput {
  e2bAuth: string; // E2B X-API-Key header value
  hermesBaseUrl: string;
  /** Optional logger so retries / breaker trips are visible. */
  log?: ResilienceLogger;
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

  // E2B's list endpoint occasionally 502s under load. Wrap in circuit
  // breaker + retry so a single transient blip doesn't fail the sweep,
  // and a sustained outage trips the breaker so we fail fast on
  // subsequent ticks until E2B recovers.
  const listResp = await withResilience(
    E2B_LIST_BREAKER,
    { name: "e2b.list", maxAttempts: 3, baseDelayMs: 200, log: input.log },
    async () => {
      const r = await fetch("https://api.e2b.dev/v2/sandboxes", {
        headers: { "X-API-Key": input.e2bAuth },
      });
      if (!r.ok) throw new RetryableHttpError(r.status, await r.text());
      return r;
    },
  );
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
      await killSandbox(input.e2bAuth, id);
      result.killed.push(id);
    } else {
      result.kept.push(id);
    }
  }

  return result;
}
