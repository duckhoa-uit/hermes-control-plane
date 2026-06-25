// ============================================================
// PrIndexDurableObject — unit tests.
// Uses the same in-process DO shim as e2e-do.test.ts: minimal storage,
// no real workerd. The point is to lock the row shape, the dedup ring,
// the idempotent register, and the prKey URL parser.
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  PrIndexDurableObject,
  prKeyFromUrl,
  type PrIndexRow,
} from "../src/worker/pr-index-do";

class FakeStorage {
  kv = new Map<string, unknown>();
  async put(key: string, value: unknown): Promise<void> { this.kv.set(key, value); }
  async get<T>(key: string): Promise<T | undefined> { return this.kv.get(key) as T | undefined; }
  async delete(key: string): Promise<boolean> { return this.kv.delete(key); }
}

class FakeCtx {
  storage = new FakeStorage();
}

function newDo(): PrIndexDurableObject {
  const ctx = new FakeCtx();
  const env = {} as CloudflareEnv;
  return new (PrIndexDurableObject as any)(ctx, env);
}

describe("prKeyFromUrl", () => {
  it("parses canonical GitHub PR URLs", () => {
    expect(prKeyFromUrl("https://github.com/duckhoa-uit/lawn/pull/42")).toBe(
      "duckhoa-uit/lawn#42",
    );
  });

  it("accepts trailing path (review/file links share the prefix)", () => {
    expect(prKeyFromUrl("https://github.com/o/r/pull/7/files")).toBe("o/r#7");
  });

  it("throws on non-PR URLs", () => {
    expect(() => prKeyFromUrl("https://github.com/o/r/issues/1")).toThrow(/cannot parse/);
    expect(() => prKeyFromUrl("https://example.com/foo")).toThrow(/cannot parse/);
  });
});

describe("PrIndexDurableObject", () => {
  let pr: PrIndexDurableObject;
  beforeEach(() => { pr = newDo(); });

  it("register inserts an open row", async () => {
    const row = await pr.register("o/r#1", "sess-A", "alice");
    expect(row).toMatchObject({
      prKey: "o/r#1",
      sessionId: "sess-A",
      ownerLogin: "alice",
      status: "open",
      autofixCount: 0,
    });
    expect(row.lastUpdated).toBeGreaterThan(0);
  });

  it("lookup returns the row by prKey", async () => {
    await pr.register("o/r#1", "sess-A", "alice");
    const found = await pr.lookup("o/r#1");
    expect(found?.sessionId).toBe("sess-A");
  });

  it("lookup returns null for missing PR", async () => {
    expect(await pr.lookup("o/r#999")).toBeNull();
  });

  it("re-register preserves autofixCount + delivery ring but updates sessionId", async () => {
    await pr.register("o/r#1", "sess-A", "alice");
    await pr.incrementAutofix("o/r#1");
    await pr.recordDelivery("o/r#1", "del-1");

    await pr.register("o/r#1", "sess-B", "alice");
    const row = await pr.lookup("o/r#1");
    expect(row?.sessionId).toBe("sess-B");
    expect(row?.autofixCount).toBe(1);
    expect(row?.recentDeliveries).toEqual(["del-1"]);
    expect(row?.status).toBe("open");
  });

  it("markStatus updates only status + lastUpdated", async () => {
    await pr.register("o/r#1", "sess-A", "alice");
    const before = (await pr.lookup("o/r#1"))!.lastUpdated;
    await new Promise((r) => setTimeout(r, 2));
    const updated = await pr.markStatus("o/r#1", "merged");
    expect(updated?.status).toBe("merged");
    expect(updated!.lastUpdated).toBeGreaterThan(before);
  });

  it("markStatus on missing PR returns null", async () => {
    expect(await pr.markStatus("o/r#999", "closed")).toBeNull();
  });

  it("incrementAutofix bumps count and returns new value", async () => {
    await pr.register("o/r#1", "sess-A", "alice");
    expect(await pr.incrementAutofix("o/r#1")).toBe(1);
    expect(await pr.incrementAutofix("o/r#1")).toBe(2);
    expect((await pr.lookup("o/r#1"))!.autofixCount).toBe(2);
  });

  it("incrementAutofix on missing PR returns null", async () => {
    expect(await pr.incrementAutofix("o/r#999")).toBeNull();
  });

  it("recordDelivery returns true once, false on replay", async () => {
    await pr.register("o/r#1", "sess-A", "alice");
    expect(await pr.recordDelivery("o/r#1", "del-1")).toBe(true);
    expect(await pr.recordDelivery("o/r#1", "del-1")).toBe(false);
    expect(await pr.recordDelivery("o/r#1", "del-2")).toBe(true);
  });

  it("recordDelivery ring is bounded (oldest evicted past 16)", async () => {
    await pr.register("o/r#1", "sess-A", "alice");
    for (let i = 0; i < 20; i++) {
      await pr.recordDelivery("o/r#1", `del-${i}`);
    }
    const row = (await pr.lookup("o/r#1"))! as PrIndexRow;
    expect(row.recentDeliveries!.length).toBe(16);
    // del-0..del-3 should have been evicted
    expect(row.recentDeliveries).not.toContain("del-0");
    expect(row.recentDeliveries).toContain("del-19");
    // A replay of an evicted delivery is, by design, treated as novel again.
    expect(await pr.recordDelivery("o/r#1", "del-0")).toBe(true);
  });

  it("recordDelivery on missing PR returns true (caller decides)", async () => {
    expect(await pr.recordDelivery("o/r#999", "del-x")).toBe(true);
  });

  it("unregister removes the row", async () => {
    await pr.register("o/r#1", "sess-A", "alice");
    expect(await pr.unregister("o/r#1")).toBe(true);
    expect(await pr.lookup("o/r#1")).toBeNull();
  });
});
