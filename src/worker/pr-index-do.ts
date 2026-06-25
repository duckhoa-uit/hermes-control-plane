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
}

const KEY_PREFIX = "pr:";
const DELIVERY_RING_MAX = 16;

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
