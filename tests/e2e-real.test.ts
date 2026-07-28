// ============================================================
// E2E Real Test — public boundary security checks
// ============================================================
// Set RUN_E2E=1 to enable (requires wrangler dev on port 8787).

import { describe, it, expect } from "vitest";

const BASE = process.env.WORKER_URL || "http://localhost:8787";
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

    it("4. Direct workflow invocation is not public", async () => {
      const res = await fetch(`${BASE}/workflows/coding-task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }),
      });
      expect(res.status).toBe(401);
    }, 30000);
  });
} else {
  describe.skip("E2E: Real against duckhoa-uit/lawn", () => {
    it("requires RUN_E2E=1", () => {});
  });
}
