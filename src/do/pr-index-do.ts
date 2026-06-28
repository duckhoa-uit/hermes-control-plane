// ============================================================
// PrIndexDurableObject — singleton index of "open PR → session".
// Ported from original src/worker/pr-index-do.ts. Zero changes to
// logic — only adapted to the new env type and runtime context.
// ============================================================

import { DurableObject } from "cloudflare:workers";

export type PrStatus = "open" | "merged" | "closed";

export interface PrIndexRow {
  prKey: string;
  sessionId: string;
  ownerLogin: string;
  status: PrStatus;
  autofixCount: number;
  lastUpdated: number;
  recentDeliveries?: string[];
  lastAmendedSha?: string;
  inflightAmendStartedAt?: number;
  inflightSessionId?: string;
}

const KEY_PREFIX = "pr:";
const DELIVERY_RING_MAX = 16;
const INFLIGHT_TTL_MS = 10 * 60 * 1000;

function rowKey(prKey: string): string {
  return `${KEY_PREFIX}${prKey}`;
}

export class PrIndexDurableObject extends DurableObject<Env> {
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

  async markStatus(prKey: string, status: PrStatus): Promise<PrIndexRow | null> {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row) return null;
    row.status = status;
    row.lastUpdated = Date.now();
    await this.ctx.storage.put(rowKey(prKey), row);
    return row;
  }

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

  async tryClaimAmendSlot(
    prKey: string,
    headSha: string,
    sessionId: string,
    cap: number,
  ): Promise<
    | { ok: true; autofixCount: number }
    | {
        ok: false;
        reason: "unknown_pr" | "cap_exceeded" | "duplicate_sha" | "inflight";
        row?: PrIndexRow;
      }
  > {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row) return { ok: false, reason: "unknown_pr" };
    if (row.status !== "open") return { ok: false, reason: "cap_exceeded", row };
    if (row.autofixCount >= cap) return { ok: false, reason: "cap_exceeded", row };
    if (row.lastAmendedSha === headSha) return { ok: false, reason: "duplicate_sha", row };

    const now = Date.now();
    if (row.inflightAmendStartedAt && now - row.inflightAmendStartedAt < INFLIGHT_TTL_MS) {
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

  async transferAmendSlot(prKey: string, newSessionId: string): Promise<void> {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row || !row.inflightAmendStartedAt) return;
    row.inflightSessionId = newSessionId;
    row.lastUpdated = Date.now();
    await this.ctx.storage.put(rowKey(prKey), row);
  }

  async releaseAmendSlot(prKey: string): Promise<void> {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row) return;
    row.inflightAmendStartedAt = undefined;
    row.inflightSessionId = undefined;
    row.lastUpdated = Date.now();
    await this.ctx.storage.put(rowKey(prKey), row);
  }

  async incrementAutofix(prKey: string): Promise<number | null> {
    const row = await this.ctx.storage.get<PrIndexRow>(rowKey(prKey));
    if (!row) return null;
    row.autofixCount += 1;
    row.lastUpdated = Date.now();
    await this.ctx.storage.put(rowKey(prKey), row);
    return row.autofixCount;
  }
}
