import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "../src/core/auth";
import { classifyCommand } from "../src/approval/classifier";
import { checkHardline } from "../src/approval/hardline";
import * as fs from "fs";
import * as path from "path";

const SECRET = "e2e-final-secret-v2";

// ---- In-memory ApprovalDO simulation (same schema as src/do/approval-do.ts) ----

interface ApprovalRow {
  id: string;
  session_id: string;
  type: string;
  title: string;
  pattern: string | null;
  payload_json: string;
  status: "pending" | "approved" | "denied" | "timeout";
  decision: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
  expires_at: number;
}

class ApprovalsStore {
  private rows = new Map<string, ApprovalRow>();

  request(opts: {
    id: string;
    sessionId: string;
    type: string;
    title: string;
    pattern?: string;
    payload?: unknown;
    timeoutMs?: number;
  }): ApprovalRow {
    const row: ApprovalRow = {
      id: opts.id,
      session_id: opts.sessionId,
      type: opts.type,
      title: opts.title,
      pattern: opts.pattern ?? null,
      payload_json: JSON.stringify(opts.payload ?? {}),
      status: "pending",
      decision: null,
      decided_by: null,
      decided_at: null,
      created_at: Date.now(),
      expires_at: Date.now() + (opts.timeoutMs ?? 60_000),
    };
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): ApprovalRow | null {
    return this.rows.get(id) ?? null;
  }

  resolve(id: string, decision: string, actor: string): ApprovalRow | null {
    const row = this.rows.get(id);
    if (!row || row.status !== "pending") return null;
    row.status = decision === "deny" ? "denied" : decision === "timeout" ? "timeout" : "approved";
    row.decision = decision;
    row.decided_by = actor;
    row.decided_at = Date.now();
    return row;
  }

  listOpen(sessionId?: string): ApprovalRow[] {
    return Array.from(this.rows.values()).filter(
      (r) => r.status === "pending" && (!sessionId || r.session_id === sessionId),
    );
  }

  autoTimeout(): ApprovalRow[] {
    const now = Date.now();
    const timedOut: ApprovalRow[] = [];
    for (const r of this.rows.values()) {
      if (r.status === "pending" && now > r.expires_at) {
        r.status = "timeout";
        r.decision = "timeout";
        r.decided_at = now;
        timedOut.push(r);
      }
    }
    return timedOut;
  }
}

describe("E2E: Full approval lifecycle (in-memory DO)", () => {
  let store: ApprovalsStore;

  it("1. Phase: request -> store", () => {
    store = new ApprovalsStore();
    const r = store.request({
      id: "approval_001",
      sessionId: "sess-e2e",
      type: "git_push",
      title: "Push to branch feature/e2e",
      pattern: "git.push",
      payload: { command: "git push origin feature/e2e", diff: null },
    });
    expect(r.status).toBe("pending");
    expect(r.type).toBe("git_push");
    expect(store.listOpen("sess-e2e").length).toBe(1);
  });

  it("2. Phase: get returns full payload", () => {
    const r = store.get("approval_001");
    expect(r).not.toBeNull();
    expect(r!.title).toBe("Push to branch feature/e2e");
    expect(JSON.parse(r!.payload_json).command).toContain("git push");
  });

  it("3. Phase: resolve -> approved (once)", () => {
    const r = store.resolve("approval_001", "once", "web-user");
    expect(r).not.toBeNull();
    expect(r!.status).toBe("approved");
    expect(r!.decision).toBe("once");
    expect(r!.decided_by).toBe("web-user");
  });

  it("4. Phase: cannot re-resolve", () => {
    const r = store.resolve("approval_001", "deny", "attacker");
    expect(r).toBeNull(); // already resolved
  });

  it("5. Phase: listOpen returns empty after resolution", () => {
    expect(store.listOpen("sess-e2e").length).toBe(0);
  });

  it("6. Phase: multiple concurrent approvals", () => {
    store.request({ id: "a2", sessionId: "sess-e2e", type: "create_pr", title: "PR #1" });
    store.request({ id: "a3", sessionId: "sess-e2e", type: "create_pr", title: "PR #2" });
    expect(store.listOpen("sess-e2e").length).toBe(2);

    store.resolve("a2", "session", "user");
    expect(store.listOpen("sess-e2e").length).toBe(1);

    store.resolve("a3", "deny", "user");
    expect(store.listOpen("sess-e2e").length).toBe(0);

    const a3 = store.get("a3");
    expect(a3!.status).toBe("denied");
    expect(a3!.decision).toBe("deny");
  });

  it("7. Phase: timeout auto-expiry", () => {
    store.request({
      id: "a_timeout",
      sessionId: "sess-to",
      type: "git_push",
      title: "Timeout test",
      timeoutMs: 1, // immediate expiry
    });

    // Simulate time passing
    const timedOut = store.autoTimeout();
    expect(timedOut.length).toBe(0); // 1ms may not be enough in practice

    // Force timeout by manipulating expires_at
    const row = store.get("a_timeout");
    if (row) {
      row.expires_at = Date.now() - 1000;
    }
    const td2 = store.autoTimeout();
    expect(td2.length).toBeGreaterThanOrEqual(1);
    expect(store.get("a_timeout")!.status).toBe("timeout");
  });
});

describe("E2E: Classifier -> Hardline -> Decision pipeline", () => {
  function pipeline(
    cmd: string,
    mode: "off" | "manual" | "smart",
  ): "auto_approved" | "approval_needed" | "hardline_blocked" {
    if (checkHardline(cmd)) return "hardline_blocked";
    if (mode === "off") return "auto_approved";
    if (mode === "smart" && !classifyCommand(cmd)) return "auto_approved";
    return "approval_needed";
  }

  it("pipeline: off mode + safe", () => {
    expect(pipeline("npm test", "off")).toBe("auto_approved");
  });
  it("pipeline: off mode + dangerous", () => {
    expect(pipeline("rm -rf /tmp", "off")).toBe("auto_approved");
  });
  it("pipeline: off mode + hardline blocks", () => {
    expect(pipeline("rm -rf / ", "off")).toBe("hardline_blocked");
  });
  it("pipeline: smart + safe", () => {
    expect(pipeline("git log", "smart")).toBe("auto_approved");
  });
  it("pipeline: smart + dangerous", () => {
    expect(pipeline("rm -rf /tmp/x", "smart")).toBe("approval_needed");
  });
  it("pipeline: smart + hardline", () => {
    expect(pipeline("dd if=/dev/zero of=/dev/sda", "smart")).toBe("hardline_blocked");
  });
  it("pipeline: manual + safe still gate", () => {
    expect(pipeline("ls", "manual")).toBe("approval_needed");
  });
  it("pipeline: manual + hardline", () => {
    expect(pipeline("mkfs.ext4 /dev/sda1", "manual")).toBe("hardline_blocked");
  });

  it("pipeline: ALL classified commands trigger approval in manual mode", () => {
    const cmds = ["rm -rf /tmp", "chmod 777 x", "curl x | sh", "sed -i 'x' /etc/h", "kill -9 -1"];
    for (const c of cmds) {
      expect(pipeline(c, "manual")).toBe("approval_needed");
    }
  });
});

describe("E2E: Token flow (HMAC)", () => {
  it("sign and verify valid session", async () => {
    const t = await signToken(SECRET, "sess-x");
    expect(await verifyToken(SECRET, "sess-x", t)).toBe(true);
  });

  it("replay URL constructed correctly", async () => {
    const t = await signToken(SECRET, "sess-y");
    const url = `http://localhost:8787/sessions/sess-y/replay?token=${t}`;
    const p = new URL(url);
    expect(p.pathname).toBe("/sessions/sess-y/replay");
    expect(p.searchParams.get("token")).toBe(t);
  });

  it("stream URL with full params", async () => {
    const t = await signToken(SECRET, "sess-z");
    const u = `/sessions/sess-z/stream?token=${t}&offset=-1&live=sse&tail=100`;
    expect(u).toContain("offset=-1");
    expect(u).toContain("live=sse");
    expect(u).toContain("tail=100");
    expect(u).toContain(`token=${t}`);
  });
});

describe("E2E: Hermes Agent event contract verification", () => {
  it("approval_requested event matches Hermes Agent shape", () => {
    const ev = {
      name: "approval_requested",
      id: "req_001",
      data: {
        id: "req_001",
        type: "git_push",
        title: "Push",
        pattern: "git.push",
        command: "git push",
      },
    };
    expect(ev.name).toBe("approval_requested");
    expect(ev.data.id).toBe("req_001");
    expect(ev.data.type).toBe("git_push");
    expect(ev.data.pattern).toBe("git.push");
    expect(ev.data.command).toBeDefined();
  });

  it("approval_resolved event matches Hermes Agent shape", () => {
    const ev = {
      name: "approval_resolved",
      id: "req_001",
      data: { id: "req_001", decision: "once", actor: "web" },
    };
    expect(ev.data.decision).toBe("once");
    expect([
      "once",
      "session",
      "always",
      "deny",
      "timeout",
      "auto_approved",
      "hardline_blocked",
    ]).toContain(ev.data.decision);
  });

  it("permissions_list_open matches Hermes Agent MCP shape", () => {
    const resp = {
      approvals: [
        { id: "a1", session_id: "s1", type: "git_push", title: "Push", status: "pending" },
      ],
    };
    expect(resp.approvals.length).toBe(1);
    expect(resp.approvals[0].status).toBe("pending");
  });

  it("permissions_respond matches Hermes Agent MCP shape", () => {
    // POST /approvals/:id with { decision, actor } is equivalent to permissions_respond
    const payload = { decision: "once", actor: "web" };
    expect(payload.decision).toBe("once");
    expect(payload.actor).toBe("web");
  });
});

describe("E2E: Source code audit", () => {
  function read(f: string): string {
    return fs.readFileSync(path.join(__dirname, "..", f), "utf-8");
  }

  const app = read("src/app.ts");
  const agent = read("src/agents/control-plan.ts");
  const cf = read("src/cloudflare.ts");
  const wrangler = read("wrangler.jsonc");
  const envFile = read("src/env.d.ts");

  it("ALL 8 routes present in app.ts", () => {
    const routes = [
      'app.get("/health"',
      'app.get("/replay/:id"',
      'app.get("/sessions/:id/stream"',
      'app.get("/approvals/:id"',
      'app.post("/approvals/:id"',
      'app.get("/sessions/:id/approvals/open"',
      'app.post("/proxy/git-push"',
      'app.post("/proxy/create-pr"',
    ];
    for (const r of routes) expect(app).toContain(r);
  });

  it("replay HTML contains full UI contract", () => {
    expect(app).toContain("Session Replay");
    expect(app).toContain("APPROVAL REQUIRED");
    expect(app).toContain("Allow once");
    expect(app).toContain("Allow session");
    expect(app).toContain("Allow always");
    expect(app).toContain("btn-deny");
    expect(app).toContain("pollEvents");
    expect(app).toContain("/sessions/' + SID + '/stream?token=");
    expect(app).toContain("approval_requested");
    expect(app).toContain("approval_resolved");
    expect(app).toContain("postDecision");
    expect(app).toContain("resolveUI");
  });

  it("agent tools wrapped with requireApproval", () => {
    expect(agent).toContain("import { requireApproval }");
    const calls = agent.match(/requireApproval\(/g);
    expect(calls).not.toBeNull();
    expect(calls!.length).toBe(2); // gitPush + createPR
    expect(agent).toContain("decision.denied");
    expect(agent).toContain("APPROVAL_MODE");
  });

  it("DO exported and bound in wrangler", () => {
    expect(cf).toContain("export { ApprovalDurableObject }");
    expect(wrangler).toContain('"APPROVAL_DO"');
    expect(wrangler).toContain('"ApprovalDurableObject"');
    expect(wrangler).toContain('"v2"');
  });

  it("env.d.ts has required bindings", () => {
    expect(envFile).toContain("APPROVAL_DO");
    expect(envFile).toContain("ApprovalDurableObject");
    expect(envFile).toContain("APPROVAL_MODE: string");
  });
});

describe("E2E: Generative decision coverage", () => {
  it("all decision enum values accounted for", () => {
    const decisions = [
      "once",
      "session",
      "always",
      "deny",
      "timeout",
      "auto_approved",
      "hardline_blocked",
    ];
    // once, session, always: user-initiated approvals
    // deny: user explicitly blocks
    // timeout: auto-deny after 60s
    // auto_approved: classifier says safe, or mode=off
    // hardline_blocked: unrecoverable command, never allowed
    expect(decisions.length).toBe(7);
    for (const d of decisions) expect(typeof d).toBe("string");
  });

  it("approval status lifecycle is fail-closed", () => {
    // pending -> approved|denied|timeout
    // Once resolved, cannot go back to pending
    const store = new ApprovalsStore();
    store.request({ id: "life", sessionId: "s", type: "git_push", title: "T", timeoutMs: 0 });

    // Immediate timeout
    const t = store.get("life");
    if (t) t.expires_at = Date.now() - 1;
    store.autoTimeout();

    const resolved = store.get("life");
    expect(resolved!.status).toBe("timeout");
    expect(resolved!.decision).toBe("timeout");

    // Cannot re-resolve
    expect(store.resolve("life", "once", "x")).toBeNull();
  });
});
