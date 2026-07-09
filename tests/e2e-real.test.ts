// ============================================================
// E2E Real Test — Full chain: agent dispatch → events → tools
// ============================================================
// Set RUN_E2E=1 to enable (requires wrangler dev on port 8787).
// State machine unit tests always run.

import { describe, it, expect } from "vitest";
import { applyLifecycleEvent } from "../src/agent/state-bridge";
import type { SessionStatus } from "../src/core/types";

const BASE = process.env.WORKER_URL || "http://localhost:8787";
const TEST_SESSION = `e2e-test-${Date.now()}`;
const RUN_E2E = process.env.RUN_E2E === "1";

if (RUN_E2E) {
  describe("E2E: Real against duckhoa-uit/lawn", () => {
    it("1. Health endpoint", async () => {
      const res = await fetch(`${BASE}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe("ok");
    });

    it("2. Proxy: git-push rejects unsigned callers", async () => {
      const res = await fetch(`${BASE}/proxy/git-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "test", headSha: "abc123" }),
      });
      const body = (await res.json()) as any;
      expect(res.status).toBe(401);
      expect(body.error).toBe("unauthorized");
    });

    it("3. Proxy: create-pr rejects unsigned callers", async () => {
      const res = await fetch(`${BASE}/proxy/create-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "test", branch: "test", body: "" }),
      });
      const body = (await res.json()) as any;
      expect(res.status).toBe(401);
      expect(body.error).toBe("unauthorized");
    });

    it("4. Agent dispatch via /agents/hermes/:sessionId", async () => {
      const res = await fetch(`${BASE}/agents/hermes/${TEST_SESSION}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Read README.md of duckhoa-uit/lawn" }),
      });
      expect([200, 202]).toContain(res.status);
      const body = (await res.json()) as any;
      if (res.status === 202) expect(body.status).toBe("accepted");
    }, 30000);

    it("5. Event stream via GET /agents/hermes/:sessionId", async () => {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await fetch(`${BASE}/agents/hermes/${TEST_SESSION}`);
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        const body = (await res.json()) as any;
        expect(body.events).toBeDefined();
        expect(Array.isArray(body.events)).toBe(true);
      }
    }, 15000);
  });
} else {
  describe.skip("E2E: Real against duckhoa-uit/lawn", () => {
    it("requires RUN_E2E=1", () => {});
  });
}

// ── State machine unit tests (always run) ──────────────────────────

describe("State Machine (unit)", () => {
  it("1. Happy path: created → completed", () => {
    let s: SessionStatus = "created";
    s = applyLifecycleEvent(s, "submitted");
    expect(s).toBe("provisioning");
    s = applyLifecycleEvent(s, "running");
    expect(s).toBe("running");
    s = applyLifecycleEvent(s, "completed");
    expect(s).toBe("completed");
  });

  it("2. needs_approval loop", () => {
    let s: SessionStatus = "running";
    s = applyLifecycleEvent(s, "needs_input");
    expect(s).toBe("needs_approval");
    s = applyLifecycleEvent(s, "running");
    expect(s).toBe("running");
    s = applyLifecycleEvent(s, "completed");
    expect(s).toBe("completed");
  });

  it("3. review_ready → running", () => {
    expect(applyLifecycleEvent("review_ready", "running")).toBe("running");
  });

  it("4. Invalid transitions throw", () => {
    expect(() => applyLifecycleEvent("completed", "running")).toThrow();
    expect(() => applyLifecycleEvent("archived", "completed")).toThrow();
  });

  it("5. Follow-up submission while running", () => {
    expect(applyLifecycleEvent("running", "submitted")).toBe("running");
  });

  it("6. provisioning → running (direct)", () => {
    expect(applyLifecycleEvent("provisioning", "running")).toBe("running");
  });
});
