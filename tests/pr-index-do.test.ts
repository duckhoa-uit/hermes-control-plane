import { describe, it, expect } from "vitest";

// Test the PR Index DO logic without the actual DO runtime.
// We test the business rules by re-creating the state transitions manually.

interface PrIndexRow {
  prKey: string;
  sessionId: string;
  ownerLogin: string;
  status: "open" | "merged" | "closed";
  autofixCount: number;
  lastUpdated: number;
  recentDeliveries?: string[];
  lastAmendedSha?: string;
  inflightAmendStartedAt?: number;
  inflightSessionId?: string;
}

describe("PR Index DO logic", () => {
  // Replicates the same business rules as PrIndexDurableObject

  function tryClaimAmendSlot(
    row: PrIndexRow | null,
    headSha: string,
    sessionId: string,
    cap: number,
    now = Date.now(),
    ttlMs = 10 * 60 * 1000,
  ): { ok: true; autofixCount: number } | { ok: false; reason: string; row?: PrIndexRow } {
    if (!row) return { ok: false, reason: "unknown_pr" };
    if (row.status !== "open") return { ok: false, reason: "cap_exceeded", row };
    if (row.autofixCount >= cap) return { ok: false, reason: "cap_exceeded", row };
    if (row.lastAmendedSha === headSha) return { ok: false, reason: "duplicate_sha", row };

    if (row.inflightAmendStartedAt && now - row.inflightAmendStartedAt < ttlMs) {
      return { ok: false, reason: "inflight", row };
    }

    row.autofixCount += 1;
    row.lastAmendedSha = headSha;
    row.inflightAmendStartedAt = now;
    row.inflightSessionId = sessionId;
    row.lastUpdated = now;
    return { ok: true, autofixCount: row.autofixCount };
  }

  const baseRow: PrIndexRow = {
    prKey: "owner/repo#1",
    sessionId: "session-1",
    ownerLogin: "test-user",
    status: "open",
    autofixCount: 0,
    lastUpdated: Date.now(),
  };

  it("allows claim on open PR", () => {
    const result = tryClaimAmendSlot({ ...baseRow }, "abc123", "session-2", 3);
    expect(result.ok).toBe(true);
  });

  it("increments autofixCount on claim", () => {
    const row = { ...baseRow };
    const result = tryClaimAmendSlot(row, "abc123", "session-2", 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.autofixCount).toBe(1);
      expect(row.autofixCount).toBe(1);
      expect(row.lastAmendedSha).toBe("abc123");
    }
  });

  it("blocks claim when cap exceeded", () => {
    const row = { ...baseRow, autofixCount: 3 };
    const result = tryClaimAmendSlot(row, "abc123", "session-2", 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cap_exceeded");
  });

  it("blocks duplicate sha", () => {
    const row = { ...baseRow, lastAmendedSha: "abc123" };
    const result = tryClaimAmendSlot(row, "abc123", "session-2", 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("duplicate_sha");
  });

  it("blocks when inflight", () => {
    const now = Date.now();
    const row = { ...baseRow, inflightAmendStartedAt: now - 1000 };
    const result = tryClaimAmendSlot(row, "abc123", "session-2", 3, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("inflight");
  });

  it("allows claim when inflight TTL expired", () => {
    const now = Date.now();
    const row = { ...baseRow, inflightAmendStartedAt: now - 11 * 60 * 1000 };
    const result = tryClaimAmendSlot(row, "abc123", "session-2", 3, now);
    expect(result.ok).toBe(true);
  });

  it("blocks claim on merged PR", () => {
    const row = { ...baseRow, status: "merged" as const };
    const result = tryClaimAmendSlot(row, "abc123", "session-2", 3);
    expect(result.ok).toBe(false);
  });

  it("blocks claim on closed PR", () => {
    const row = { ...baseRow, status: "closed" as const };
    const result = tryClaimAmendSlot(row, "abc123", "session-2", 3);
    expect(result.ok).toBe(false);
  });

  it("delivery ring dedup works", () => {
    const deliveries: string[] = [];
    const deliveryId = "delivery-1";

    // First time: novel
    const isNew1 = !deliveries.includes(deliveryId);
    expect(isNew1).toBe(true);
    deliveries.push(deliveryId);

    // Second time: duplicate
    const isNew2 = !deliveries.includes(deliveryId);
    expect(isNew2).toBe(false);
  });

  it("delivery ring bounded to 16", () => {
    const ring: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `delivery-${i}`;
      if (ring.includes(id)) continue;
      ring.push(id);
      while (ring.length > 16) ring.shift();
    }
    expect(ring.length).toBeLessThanOrEqual(16);
    expect(ring[0]).toBe("delivery-4"); // first 4 were shifted out
  });
});
