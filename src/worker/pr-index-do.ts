// ============================================================
// PrIndexDurableObject — singleton index of "open PR → session".
// Lets the webhook handler (POST /webhooks/github) and the MCP follow-up
// path map an `owner/repo#N` PR key back to the SessionDurableObject id
// that opened it.
//
// Singleton: addressed via env.PR_INDEX_DO.idFromName("global"). Per-PR
// rows live at storage key `pr:<owner>/<repo>#<number>`.
// ============================================================

import { DurableObject } from "cloudflare:workers";

export type PrStatus = "open" | "merged" | "closed";

export interface PrIndexRow {
  /** "owner/repo#N" — primary key. */
  prKey: string;
  /** SessionDurableObject id (idFromString-decodable) that opened this PR. */
  sessionId: string;
  /** GitHub login of the user the session was running as. */
  ownerLogin: string;
  /** Lifecycle marker — webhook handler keeps this in sync. */
  status: PrStatus;
  /** Number of follow-up sessions spawned against this PR. Currently
   *  maintained but not enforced; reserved for future quota work. */
  autofixCount: number;
  /** Wall-clock ms of the most recent mutation. */
  lastUpdated: number;
  /** Most recent X-GitHub-Delivery ids the webhook handler accepted for
   *  this PR. Bounded ring (max ~16) so duplicate webhook deliveries
   *  (GitHub retries) become no-ops. Populated by the webhook handler. */
  recentDeliveries?: string[];
  /** Last commit sha for which the webhook handler successfully spawned
   *  an auto-amend session. Used to dedup: if a `pull_request_review.
   *  submitted` arrives twice for the same head sha (e.g. webhook retry
   *  or the user re-submitting the same review) we skip. */
  lastAmendedSha?: string;
  /** Wall-clock ms set when tryClaimAmendSlot succeeds; cleared by
   *  releaseAmendSlot on session terminal. Strict single-flight per
   *  PR: while this is set, further tryClaim calls return `inflight`.
   *  A stale claim older than INFLIGHT_TTL_MS (10 min) is auto-released
   *  by the next tryClaim so a crashed worker can't deadlock the PR. */
  inflightAmendStartedAt?: number;
  /** Session id of the in-flight amend; used by webhook handler to log
   *  what is blocking. */
  inflightSessionId?: string;
}

const KEY_PREFIX = "pr:";
const DELIVERY_RING_MAX = 16;
/** Single-flight amend slot TTL. A crashed/forgotten claim auto-expires
 *  so a single bad run cannot lock the PR forever. 10 min is comfortably
 *  larger than a typical Hermes amend turn (~30 s) and smaller than the
 *  launcher's 15-min sandbox idle timeout. */
const INFLIGHT_TTL_MS = 10 * 60 * 1000;

function rowKey(prKey: string): string {
  return `${KEY_PREFIX}${prKey}`;
}

export class PrIndexDurableObject extends DurableObject<CloudflareEnv> {
  /** Insert (or refresh) the row for a freshly-created PR. Idempotent —
   *  calling again with the same sessionId is a no-op except for
   *  lastUpdated; calling with a different sessionId overwrites (the
   *  newer session "wins" the PR, which matches our follow-up amend
   *  flow where parentSessionId is the old one). */
  async register(prKey: string, sessionId: string, ownerLogin: string): Promise<PrIndexRow> {
    const existing = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    const row: PrIndexRow = {
      prKey,
      sessionId,
      ownerLogin,
      status: "open",
      autofixCount: existing?.autofixCount ?? 0,
      lastUpdated: Date.now(),
      recentDeliveries: existing?.recentDeliveries,
      lastAmendedSha: existing?.lastAmendedSha,
      inflightAmendStartedAt: existing?.inflightAmendStartedAt,
      inflightSessionId: existing?.inflightSessionId,
    };
    await this.ctx.storage.put(rowKey(prKey), row);
    return row;
  }

  async lookup(prKey: string): Promise<PrIndexRow | null> {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    return row ?? null;
  }

  /** Update only the lifecycle status (merged/closed). No-op if the row
   *  is missing — webhook handler logs and moves on. */
  async markStatus(prKey: string, status: PrStatus): Promise<PrIndexRow | null> {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row) return null;
    row.status = status;
    row.lastUpdated = Date.now();
    await this.ctx.storage.put(rowKey(prKey), row);
    return row;
  }

  /** Bump the follow-up counter. Reserved for future quota enforcement;
   *  callers bump it once per follow-up spawn. Returns the new count, or
   *  null if the PR is unknown. */
  async incrementAutofix(prKey: string): Promise<number | null> {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row) return null;
    row.autofixCount += 1;
    row.lastUpdated = Date.now();
    await this.ctx.storage.put(rowKey(prKey), row);
    return row.autofixCount;
  }

  /** Atomic check-and-record for webhook delivery dedup. Returns `true`
   *  if the delivery id was novel (caller should process); `false` if it
   *  has already been seen recently (caller should ack 200 + skip).
   *  Returns `true` for unknown PRs so the caller can decide. */
  async recordDelivery(prKey: string, deliveryId: string): Promise<boolean> {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row) return true;
    const ring = row.recentDeliveries ?? [];
    if (ring.includes(deliveryId)) return false;
    ring.push(deliveryId);
    while (ring.length > DELIVERY_RING_MAX) ring.shift();
    row.recentDeliveries = ring;
    row.lastUpdated = Date.now();
    await this.ctx.storage.put(rowKey(prKey), row);
    return true;
  }

  async unregister(prKey: string): Promise<boolean> {
    return await this.ctx.storage.delete(rowKey(prKey));
  }

  /** Strict single-flight auto-amend claim. Returns `ok: true` when the
   *  caller may spawn a fresh amend session for this PR, otherwise a
   *  reason explaining why the claim was refused. On success, callers
   *  MUST call releaseAmendSlot when the spawned session reaches a
   *  terminal state; otherwise the slot times out after INFLIGHT_TTL_MS.
   *
   *  Reasons:
   *    - "unknown_pr" — no row for this prKey.
   *    - "cap_exceeded" — autofixCount has reached the configured cap.
   *    - "duplicate_sha" — we already amended this head sha (typically
   *       a webhook retry or a no-op re-submitted review).
   *    - "inflight" — another amend is currently running for this PR.
   *
   *  The check + mutation is single-trip: SQLite-backed DOs serialize
   *  writes per object, and this is the singleton PR_INDEX_DO, so two
   *  concurrent webhook handlers cannot both succeed. */
  async tryClaimAmendSlot(
    prKey: string,
    headSha: string,
    sessionId: string,
    cap: number,
  ): Promise<
    | { ok: true; autofixCount: number }
    | { ok: false; reason: "unknown_pr" | "cap_exceeded" | "duplicate_sha" | "inflight"; row?: PrIndexRow }
  > {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row) return { ok: false, reason: "unknown_pr" };
    if (row.status !== "open") return { ok: false, reason: "cap_exceeded", row };
    if (row.autofixCount >= cap) return { ok: false, reason: "cap_exceeded", row };
    if (row.lastAmendedSha === headSha) return { ok: false, reason: "duplicate_sha", row };

    // Inflight guard with TTL — a crashed amend would otherwise lock
    // the PR forever.
    const now = Date.now();
    if (
      row.inflightAmendStartedAt &&
      now - row.inflightAmendStartedAt < INFLIGHT_TTL_MS
    ) {
      return { ok: false, reason: "inflight", row };
    }

    row.autofixCount += 1;
    row.lastAmendedSha = headSha;
    row.inflightAmendStartedAt = now;
    row.inflightSessionId = sessionId;
    row.lastUpdated = now;
    await this.ctx.storage.put(rowKey(prKey), row);
    return { ok: true, autofixCount: row.autofixCount };
  }

  /** Re-stamp the inflightSessionId on an existing slot. Called by the
   *  webhook handler after the launcher returns the spawned session id —
   *  the original claim was made with the parent session id (we did not
   *  have the new id yet), so we hand over ownership to the spawned
   *  session, whose own transition() hook will then call releaseAmendSlot
   *  with the matching id. No-op when no slot is held. */
  async transferAmendSlot(prKey: string, newSessionId: string): Promise<void> {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row || !row.inflightAmendStartedAt) return;
    row.inflightSessionId = newSessionId;
    row.lastUpdated = Date.now();
    await this.ctx.storage.put(rowKey(prKey), row);
  }

  /** Roll back a claim that failed to spawn (launcher unreachable / 5xx).
   *  Restores autofixCount to its pre-claim value and clears lastAmendedSha
   *  so the next webhook for the same sha can retry. Only mutates when the
   *  sessionId still matches the inflight one (otherwise we would corrupt
   *  a re-claim that happened in the meantime). Used by the webhook
   *  handler on infrastructure failure; the spawned-session terminal
   *  path uses releaseAmendSlot instead because the work DID land. */
  async rollbackAmendClaim(prKey: string, sessionId: string): Promise<void> {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row) return;
    if (row.inflightSessionId !== sessionId) return;
    row.autofixCount = Math.max(0, row.autofixCount - 1);
    row.lastAmendedSha = undefined;
    row.inflightAmendStartedAt = undefined;
    row.inflightSessionId = undefined;
    row.lastUpdated = Date.now();
    await this.ctx.storage.put(rowKey(prKey), row);
  }

  /** Release the single-flight slot. Called when the auto-amend session
   *  reaches a terminal state (success or failure). Idempotent — calling
   *  twice or against a row that no longer holds the slot is a no-op.
   *  Only releases when sessionId matches inflightSessionId; pass through
   *  transferAmendSlot first if the claimant changed mid-flight. */
  async releaseAmendSlot(prKey: string, sessionId: string): Promise<void> {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row) return;
    if (row.inflightSessionId && row.inflightSessionId !== sessionId) return;
    row.inflightAmendStartedAt = undefined;
    row.inflightSessionId = undefined;
    row.lastUpdated = Date.now();
    await this.ctx.storage.put(rowKey(prKey), row);
  }
}

/** Build the "owner/repo#N" primary key from a GitHub PR URL.
 *  Accepts https://github.com/<owner>/<repo>/pull/<n>. Throws on mismatch. */
export function prKeyFromUrl(prUrl: string): string {
  const m = prUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`cannot parse GitHub PR URL: ${prUrl}`);
  return `${m[1]}/${m[2]}#${m[3]}`;
}

/** Get the singleton PrIndexDurableObject stub. */
export function getPrIndexStub(
  env: { PR_INDEX_DO: DurableObjectNamespace<PrIndexDurableObject> },
): DurableObjectStub<PrIndexDurableObject> {
  const id = env.PR_INDEX_DO.idFromName("global");
  return env.PR_INDEX_DO.get(id);
}
