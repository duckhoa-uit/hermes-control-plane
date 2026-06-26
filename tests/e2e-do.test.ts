// ============================================================
// Real E2E: drives SessionDurableObject end-to-end against an
// in-process shim of DurableObjectState / WebSocket / Worker fetch.
//
// This is NOT a unit test — it exercises:
//   - RPC methods (initSession / getState / sendPrompt / approveRequest /
//     abortSession / createPR)
//   - WS upgrade via fetch() returning { webSocket }
//   - Hibernation accessors: ctx.acceptWebSocket / ctx.getWebSockets
//   - serializeAttachment / deserializeAttachment per-conn lastSeq
//   - storage.put per-event key (evt:000…) + restore via storage.list
//   - alarm-based heartbeat watchdog (storage.setAlarm + alarm())
//   - blockConcurrencyWhile race protection in init()
//   - Worker top-level fetch routes mapping RPC results to HTTP
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { SessionDurableObject } from "../src/worker/session-do";
import worker from "../src/worker/index";
import type { ProjectProfile } from "../src/core/types";

// ---------- WebSocket pair shim ----------

type Listener<T = any> = (ev: T) => void;

class FakeWebSocket {
  readyState = 1;
  private _attachment: unknown = null;
  private peer: FakeWebSocket | null = null;
  private listeners: Record<string, Listener[]> = {};
  // Buffer for inbound messages received before any `message` listener was
  // attached. Tests routinely attach the listener AFTER worker.fetch returns,
  // by which point handleRunnerWS has already pushed the initial agent.prompt.
  private pendingInbound: any[] = [];
  // Same for close events that race the listener.
  private pendingClose: { code: number; reason: string } | null = null;
  accepted = false;
  closed = false;
  closeCode: number | null = null;
  closeReason: string = "";

  serverHandler: {
    onMessage?: (ws: WebSocket, data: string | ArrayBuffer) => void | Promise<void>;
    onClose?: (ws: WebSocket, code: number, reason: string, wasClean: boolean) => void | Promise<void>;
  } = {};

  bind(other: FakeWebSocket) {
    this.peer = other;
    other.peer = this;
  }

  accept() { this.accepted = true; }

  send(data: string | ArrayBuffer) {
    if (!this.peer) return;
    if (this.peer.serverHandler.onMessage) {
      void this.peer.serverHandler.onMessage(this.peer as unknown as WebSocket, data);
    } else {
      const ls = this.peer.listeners["message"] ?? [];
      if (ls.length === 0) {
        this.peer.pendingInbound.push({ data });
      } else {
        for (const l of ls) l({ data });
      }
    }
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    if (this.peer && !this.peer.closed) {
      if (this.peer.serverHandler.onClose) {
        void this.peer.serverHandler.onClose(this.peer as unknown as WebSocket, code, reason, true);
      }
      const ls = this.peer.listeners["close"] ?? [];
      if (ls.length === 0) {
        this.peer.pendingClose = { code, reason };
      } else {
        for (const l of ls) l({ code, reason });
      }
      this.peer.closed = true;
      this.peer.closeCode = code;
      this.peer.closeReason = reason;
    }
  }

  addEventListener(type: string, l: Listener) {
    (this.listeners[type] ??= []).push(l);
    // Flush any messages that arrived before this listener.
    if (type === "message" && this.pendingInbound.length > 0) {
      const buf = this.pendingInbound;
      this.pendingInbound = [];
      for (const ev of buf) l(ev);
    }
    if (type === "close" && this.pendingClose) {
      const c = this.pendingClose;
      this.pendingClose = null;
      l(c);
    }
  }
  removeEventListener(type: string, l: Listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(x => x !== l);
  }

  serializeAttachment(v: unknown) { this._attachment = v; }
  deserializeAttachment() { return this._attachment; }

  // Test helper: the side returned to the caller (`client` half) doesn't
  // own the attachment — the DO writes it on the `server` half. Tests that
  // want to inspect attachments should ask the FakeDOState for the server
  // WS via ctx.getWebSockets(). This getter exposes the peer's attachment
  // for ergonomic test assertions.
  peerAttachment() { return this.peer?._attachment ?? null; }
}

(globalThis as any).WebSocketPair = class {
  0: FakeWebSocket;
  1: FakeWebSocket;
  constructor() {
    const a = new FakeWebSocket();
    const b = new FakeWebSocket();
    a.bind(b);
    this[0] = a;
    this[1] = b;
  }
};

// Make Response support `webSocket` field + status 101 (workerd allows it,
// Node's Response constructor doesn't). For WS upgrade we return a thin
// non-Response object that quacks like one.
const RealResponse = globalThis.Response;
class WSResponse {
  status: number;
  headers: Headers;
  webSocket: FakeWebSocket | null;
  private _body: any;
  constructor(body: any, init?: ResponseInit & { webSocket?: FakeWebSocket }) {
    this._body = body;
    this.status = init?.status ?? 200;
    this.headers = new Headers(init?.headers ?? {});
    this.webSocket = (init as any)?.webSocket ?? null;
  }
  async json() { return typeof this._body === "string" ? JSON.parse(this._body) : this._body; }
  async text() { return typeof this._body === "string" ? this._body : JSON.stringify(this._body); }
  get ok() { return this.status >= 200 && this.status < 300; }
}
(globalThis as any).Response = WSResponse;

// ---------- Storage shim ----------

class FakeStorage {
  kv = new Map<string, unknown>();
  alarmAt: number | null = null;

  async put(key: string, value: unknown): Promise<void> { this.kv.set(key, value); }
  async get<T>(key: string): Promise<T | undefined> { return this.kv.get(key) as T | undefined; }
  async delete(key: string): Promise<boolean> { return this.kv.delete(key); }
  async list<T>(opts?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const prefix = opts?.prefix ?? "";
    const keys = [...this.kv.keys()].filter(k => k.startsWith(prefix)).sort();
    for (const k of keys) out.set(k, this.kv.get(k) as T);
    return out;
  }
  async setAlarm(when: number): Promise<void> { this.alarmAt = when; }
  async deleteAlarm(): Promise<void> { this.alarmAt = null; }
  async getAlarm(): Promise<number | null> { return this.alarmAt; }
}

// ---------- DurableObjectState shim ----------

class FakeDOState {
  id: { toString: () => string };
  storage = new FakeStorage();
  private sockets: { ws: FakeWebSocket; tags: string[] }[] = [];
  // Background promises kicked off via waitUntil — tests can await pending.
  pending: Promise<unknown>[] = [];

  constructor(idStr: string) {
    this.id = { toString: () => idStr };
  }

  waitUntil(p: Promise<unknown>): void { this.pending.push(p); }

  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> { return await fn(); }

  acceptWebSocket(ws: FakeWebSocket, tags: string[] = []) {
    ws.accept();
    this.sockets.push({ ws, tags });
    // Wire server-side handlers — point them at the DO methods set by the DO.
    ws.serverHandler.onMessage = (s, data) => this._onMessage?.(s, data);
    ws.serverHandler.onClose = (s, code, reason, wasClean) => this._onClose?.(s, code, reason, wasClean);
  }
  getWebSockets(tag?: string): FakeWebSocket[] {
    return this.sockets
      .filter(s => !s.ws.closed && (tag === undefined || s.tags.includes(tag)))
      .map(s => s.ws);
  }

  // Wired by the test harness once a DO instance exists, so that incoming
  // ws messages are dispatched into the real DO's webSocketMessage / webSocketClose.
  _onMessage?: (ws: WebSocket, data: string | ArrayBuffer) => void | Promise<void>;
  _onClose?: (ws: WebSocket, code: number, reason: string, wasClean: boolean) => void | Promise<void>;
}

// ---------- Mock DurableObjectNamespace (env.SESSION_DO) ----------

// Each unique id string → one DO instance.
class FakeStub {
  private fetchHandler: (req: Request) => Promise<Response>;
  constructor(
    private instance: SessionDurableObject,
    fetchHandler: (req: Request) => Promise<Response>,
  ) { this.fetchHandler = fetchHandler; }

  async fetch(req: Request) { return this.fetchHandler(req); }
  // Proxy RPC methods
  initSession(...args: any[]) { return (this.instance as any).initSession(...args); }
  getState() { return (this.instance as any).getState(); }
  approveRequest(rid: string) { return (this.instance as any).approveRequest(rid); }
  abortSession() { return (this.instance as any).abortSession(); }
  createPR() { return (this.instance as any).createPR(); }
  sendPrompt(text: string) { return (this.instance as any).sendPrompt(text); }
  ingestPrLifecycleEvent(input: any) { return (this.instance as any).ingestPrLifecycleEvent(input); }
  appendAutofixEvent(input: any) { return (this.instance as any).appendAutofixEvent(input); }
}

interface FakeEnv {
  SESSION_DO: {
    newUniqueId(): { toString(): string };
    idFromString(s: string): { toString(): string };
    get(id: { toString(): string }): FakeStub;
  };
  PR_INDEX_DO: {
    idFromName(name: string): { toString(): string };
    get(id: { toString(): string }): {
      register(prKey: string, sessionId: string, ownerLogin: string): Promise<any>;
      lookup(prKey: string): Promise<any>;
      markStatus(prKey: string, status: string): Promise<any>;
      recordDelivery(prKey: string, deliveryId: string): Promise<boolean>;
      incrementAutofix(prKey: string): Promise<number | null>;
      unregister(prKey: string): Promise<boolean>;
      tryClaimAmendSlot(prKey: string, headSha: string, sessionId: string, cap: number): Promise<any>;
      transferAmendSlot(prKey: string, newSessionId: string): Promise<void>;
      releaseAmendSlot(prKey: string, sessionId: string): Promise<void>;
      rollbackAmendClaim(prKey: string, sessionId: string): Promise<void>;
    };
  };
  E2B_TEMPLATE: string;
  E2B_API_KEY?: string;
  CONTROL_PLANE_LAUNCHER_URL?: string;
  PUBLIC_BASE_URL?: string;
}

let counter = 0;
const instances = new Map<string, { instance: SessionDurableObject; ctx: FakeDOState }>();
// Captured calls to PR_INDEX_DO.register so tests can assert wiring.
export const prIndexRegisterCalls: { prKey: string; sessionId: string; ownerLogin: string }[] = [];

// Process-wide in-memory PR index — mirrors the real singleton DO so the
// webhook handler can lookup/markStatus/recordDelivery against the same
// row that onPRCreated registered. Reset in beforeEach.
type FakeIndexRow = {
  prKey: string;
  sessionId: string;
  ownerLogin: string;
  status: "open" | "merged" | "closed";
  autofixCount: number;
  lastUpdated: number;
  recentDeliveries: string[];
  lastAmendedSha?: string;
  inflightAmendStartedAt?: number;
  inflightSessionId?: string;
};
export const prIndexRows = new Map<string, FakeIndexRow>();

function makeEnv(): FakeEnv {
  return {
    SESSION_DO: {
      newUniqueId() {
        const id = `id_${++counter}_${Date.now()}`;
        return { toString: () => id };
      },
      idFromString(s: string) { return { toString: () => s }; },
      get(id: { toString(): string }) {
        const key = id.toString();
        let entry = instances.get(key);
        if (!entry) {
          const ctx = new FakeDOState(key);
          const instance = new (SessionDurableObject as any)(ctx, makeEnv());
          // Wire WS event delivery into the DO's hibernation handlers
          ctx._onMessage = (ws, data) => (instance as any).webSocketMessage(ws, data);
          ctx._onClose = (ws, code, reason, wasClean) => (instance as any).webSocketClose(ws, code, reason, wasClean);
          entry = { instance, ctx };
          instances.set(key, entry);
        }
        return new FakeStub(entry.instance, (req) => (entry!.instance as any).fetch(req));
      },
    },
    PR_INDEX_DO: {
      idFromName(name: string) { return { toString: () => `pr-index:${name}` }; },
      get(_id: { toString(): string }) {
        return {
          async register(prKey: string, sessionId: string, ownerLogin: string) {
            prIndexRegisterCalls.push({ prKey, sessionId, ownerLogin });
            const existing = prIndexRows.get(prKey);
            const row: FakeIndexRow = {
              prKey,
              sessionId,
              ownerLogin,
              status: "open",
              autofixCount: existing?.autofixCount ?? 0,
              lastUpdated: Date.now(),
              recentDeliveries: existing?.recentDeliveries ?? [],
              lastAmendedSha: existing?.lastAmendedSha,
              inflightAmendStartedAt: existing?.inflightAmendStartedAt,
              inflightSessionId: existing?.inflightSessionId,
            };
            prIndexRows.set(prKey, row);
            return row;
          },
          async lookup(prKey: string) {
            return prIndexRows.get(prKey) ?? null;
          },
          async markStatus(prKey: string, status: "open" | "merged" | "closed") {
            const row = prIndexRows.get(prKey);
            if (!row) return null;
            row.status = status;
            row.lastUpdated = Date.now();
            return row;
          },
          async recordDelivery(prKey: string, deliveryId: string): Promise<boolean> {
            const row = prIndexRows.get(prKey);
            if (!row) return true;
            if (row.recentDeliveries.includes(deliveryId)) return false;
            row.recentDeliveries.push(deliveryId);
            while (row.recentDeliveries.length > 16) row.recentDeliveries.shift();
            return true;
          },
          async incrementAutofix(prKey: string): Promise<number | null> {
            const row = prIndexRows.get(prKey);
            if (!row) return null;
            row.autofixCount += 1;
            return row.autofixCount;
          },
          async unregister(prKey: string): Promise<boolean> {
            return prIndexRows.delete(prKey);
          },
          async tryClaimAmendSlot(prKey: string, headSha: string, sessionId: string, cap: number) {
            const row = prIndexRows.get(prKey);
            if (!row) return { ok: false, reason: "unknown_pr" };
            if (row.status !== "open") return { ok: false, reason: "cap_exceeded", row };
            if (row.autofixCount >= cap) return { ok: false, reason: "cap_exceeded", row };
            if (row.lastAmendedSha === headSha) return { ok: false, reason: "duplicate_sha", row };
            const now = Date.now();
            if (row.inflightAmendStartedAt && now - row.inflightAmendStartedAt < 10 * 60 * 1000) {
              return { ok: false, reason: "inflight", row };
            }
            row.autofixCount += 1;
            row.lastAmendedSha = headSha;
            row.inflightAmendStartedAt = now;
            row.inflightSessionId = sessionId;
            row.lastUpdated = now;
            return { ok: true, autofixCount: row.autofixCount };
          },
          async transferAmendSlot(prKey: string, newSessionId: string) {
            const row = prIndexRows.get(prKey);
            if (!row || !row.inflightAmendStartedAt) return;
            row.inflightSessionId = newSessionId;
            row.lastUpdated = Date.now();
          },
          async releaseAmendSlot(prKey: string, sessionId: string) {
            const row = prIndexRows.get(prKey);
            if (!row) return;
            if (row.inflightSessionId && row.inflightSessionId !== sessionId) return;
            row.inflightAmendStartedAt = undefined;
            row.inflightSessionId = undefined;
            row.lastUpdated = Date.now();
          },
          async rollbackAmendClaim(prKey: string, sessionId: string) {
            const row = prIndexRows.get(prKey);
            if (!row) return;
            if (row.inflightSessionId !== sessionId) return;
            row.autofixCount = Math.max(0, row.autofixCount - 1);
            row.lastAmendedSha = undefined;
            row.inflightAmendStartedAt = undefined;
            row.inflightSessionId = undefined;
            row.lastUpdated = Date.now();
          },
        };
      },
    },
    E2B_TEMPLATE: "control-plane-runner",
    E2B_API_KEY: "test-key", // present so provisionSandbox doesn't fail
    CONTROL_PLANE_LAUNCHER_URL: "http://launcher.invalid",
  };
}

const PROFILE: Partial<ProjectProfile> = {
  name: "test",
  defaultBranch: "main",
  model: "test-model",
  allowedTools: ["read", "edit"],
};

beforeEach(() => { instances.clear(); counter = 0; prIndexRegisterCalls.length = 0; prIndexRows.clear(); });

// ---------- Tests ----------

describe("E2E: Worker + SessionDurableObject", () => {
  it("create session via Worker.fetch → returns 201 + runner token + initial event", async () => {
    const env = makeEnv() as any;
    const req = new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "p1",
        taskDescription: "do thing",
        // No repoUrl → provisionSandbox skips so we don't need a real E2B
        profile: PROFILE,
      }),
    });
    const resp = await worker.fetch(req, env);
    expect(resp.status).toBe(201);
    const body = await resp.json() as any;
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("created");
    expect(body.runnerToken).toMatch(/^.+$/);

    // GET /sessions/:id → 200 with session + events array including session.created
    const stateResp = await worker.fetch(
      new Request(`https://x/sessions/${body.id}`),
      env,
    );
    expect(stateResp.status).toBe(200);
    const state = await stateResp.json() as any;
    expect(state.session.status).toBe("created");
    expect(state.events.length).toBeGreaterThan(0);
    expect(state.events[0].type).toBe("session.created");
  });

  it("unknown session id returns 404", async () => {
    const env = makeEnv() as any;
    // GET unknown — DO auto-instantiates empty, then 404 because no session
    const resp = await worker.fetch(new Request("https://x/sessions/does-not-exist"), env);
    expect(resp.status).toBe(404);
  });

  it("runner WS handshake: invalid token → close(4001)", async () => {
    const env = makeEnv() as any;
    // Create session
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id } = await createResp.json() as any;

    // Send WS upgrade with wrong token
    const wsResp = await worker.fetch(new Request(
      `https://x/sessions/${id}/runner?token=WRONG`,
      { headers: { Upgrade: "websocket" } },
    ), env);
    expect(wsResp.status).toBe(101);
    const ws = (wsResp as any).webSocket as FakeWebSocket;
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(4001);
  });

  it("full happy path: client subscribes, runner connects, agent emits events, runner.complete → review_ready, create-pr → completed", async () => {
    const env = makeEnv() as any;

    // 1. Create session
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "fix bug", profile: PROFILE }),
    }), env);
    const created = await createResp.json() as any;
    const { id, runnerToken } = created;

    // 2. Client WS subscribes
    const clientResp = await worker.fetch(new Request(
      `https://x/sessions/${id}/stream`,
      { headers: { Upgrade: "websocket" } },
    ), env);
    expect(clientResp.status).toBe(101);
    const clientWS = (clientResp as any).webSocket as FakeWebSocket;
    const clientEvents: any[] = [];
    clientWS.addEventListener("message", (e: any) => clientEvents.push(JSON.parse(e.data)));

    // 3. Runner WS connects with valid token
    const runnerResp = await worker.fetch(new Request(
      `https://x/sessions/${id}/runner?token=${runnerToken}`,
      { headers: { Upgrade: "websocket" } },
    ), env);
    expect(runnerResp.status).toBe(101);
    const runnerWS = (runnerResp as any).webSocket as FakeWebSocket;
    const runnerInbound: any[] = [];
    runnerWS.addEventListener("message", (e: any) => runnerInbound.push(JSON.parse(e.data)));

    // Give DO microtasks a chance to flush event broadcast
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 10));

    // 4. Runner should have received a `command` for the initial agent.prompt
    const initialPrompt = runnerInbound.find(m => m.type === "command" && m.command?.type === "agent.prompt");
    expect(initialPrompt).toBeDefined();
    expect(initialPrompt.command.payload.taskDescription).toBe("fix bug");

    // 5. Runner streams agent events
    const sendRunner = (payload: any) => runnerWS.send(JSON.stringify(payload));
    sendRunner({ type: "runner.event", sessionId: id, payload: { eventType: "agent.message.delta", eventPayload: { text: "hi" } } });
    sendRunner({ type: "runner.heartbeat", sessionId: id });

    // 6. Runner signals completion (artifacts)
    sendRunner({
      type: "runner.complete",
      sessionId: id,
      payload: { summary: "done", diff: "+x", changedFiles: ["a.ts"] },
    });
    await new Promise(r => setTimeout(r, 10));

    // 7. Verify state is review_ready
    const state1 = await env.SESSION_DO.get(env.SESSION_DO.idFromString(id)).getState();
    expect(state1.session.status).toBe("review_ready");
    expect(state1.artifacts).toBeDefined();
    expect(state1.artifacts.summary).toBe("done");

    // 8. Client should have received broadcast events for the runner events
    const clientGotAgentMsg = clientEvents.find(m =>
      m.type === "event" && m.event?.type === "agent.message.delta",
    );
    expect(clientGotAgentMsg).toBeDefined();

    // 9. POST /sessions/:id/create-pr → transitions to creating_pr
    const prResp = await worker.fetch(new Request(
      `https://x/sessions/${id}/create-pr`, { method: "POST" }
    ), env);
    expect(prResp.status).toBe(200);

    await new Promise(r => setTimeout(r, 10));

    // Runner sees pr.create command
    const prCmd = runnerInbound.find(m => m.type === "command" && m.command?.type === "pr.create");
    expect(prCmd).toBeDefined();

    // Runner reports pr.created (with ownerLogin → PR_INDEX_DO.register).
    sendRunner({
      type: "runner.event",
      sessionId: id,
      payload: {
        eventType: "pr.created",
        eventPayload: {
          url: "https://github.com/x/y/pull/1",
          ownerLogin: "alice",
        },
      },
    });
    await new Promise(r => setTimeout(r, 10));

    const state2 = await env.SESSION_DO.get(env.SESSION_DO.idFromString(id)).getState();
    expect(state2.session.status).toBe("completed");
    expect(state2.artifacts.prUrl).toBe("https://github.com/x/y/pull/1");

    // PR Index DO must have one register() call for this PR.
    expect(prIndexRegisterCalls).toEqual([
      { prKey: "x/y#1", sessionId: id, ownerLogin: "alice" },
    ]);
  });

  it("event log persists per-key (storage.list returns events in seq order)", async () => {
    const env = makeEnv() as any;
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id } = await createResp.json() as any;

    // Inspect storage directly
    const entry = instances.get(id)!;
    const evtKeys = [...entry.ctx.storage.kv.keys()].filter(k => k.startsWith("evt:"));
    expect(evtKeys.length).toBeGreaterThanOrEqual(1);
    // Zero-padded so lex sort == seq sort
    for (const k of evtKeys) expect(k).toMatch(/^evt:\d{10}$/);

    // Drop in-memory eventLog by simulating eviction → restore should rebuild it
    const inst = entry.instance as any;
    inst.session = null;
    inst.eventLog.clear();
    await inst.restore();
    expect(inst.eventLog.count()).toBe(evtKeys.length);
  });

  it("alarm-based heartbeat: setAlarm scheduled on runner connect; alarm() detects stale heartbeat → failed", async () => {
    const env = makeEnv() as any;
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id, runnerToken } = await createResp.json() as any;

    // Runner connects → startHeartbeatCheck() called → alarm scheduled
    await worker.fetch(new Request(
      `https://x/sessions/${id}/runner?token=${runnerToken}`,
      { headers: { Upgrade: "websocket" } },
    ), env);
    await new Promise(r => setTimeout(r, 5));

    const entry = instances.get(id)!;
    expect(entry.ctx.storage.alarmAt).not.toBeNull();
    expect(entry.ctx.storage.alarmAt!).toBeGreaterThan(Date.now());

    // Force a stale heartbeat: rewind lastHeartbeat by 16 minutes (> HEARTBEAT_TIMEOUT_MS)
    const inst = entry.instance as any;
    inst.session.lastHeartbeat = Date.now() - 16 * 60_000;

    // Fire alarm() handler
    await inst.alarm();

    const state = await env.SESSION_DO.get(env.SESSION_DO.idFromString(id)).getState();
    expect(state.session.status).toBe("failed");
    expect(state.session.errorMessage).toContain("stalled");
  });

  it("blockConcurrencyWhile in init(): concurrent init calls → second throws 'already initialized'", async () => {
    const env = makeEnv() as any;
    const id = env.SESSION_DO.newUniqueId();
    const stub1 = env.SESSION_DO.get(id);
    const stub2 = env.SESSION_DO.get(id);

    const r1 = stub1.initSession({ id: "p1", ...PROFILE, repoUrl: "" } as any, "a", "https://x");
    const r2 = stub2.initSession({ id: "p1", ...PROFILE, repoUrl: "" } as any, "b", "https://x").catch((e: Error) => e);

    const [first, second] = await Promise.all([r1, r2]);
    expect(first.id).toBeTruthy();
    expect(second).toBeInstanceOf(Error);
    expect((second as Error).message).toMatch(/already initialized/);
  });

  it("sendPrompt with terminal session returns kind:'terminal' (410)", async () => {
    const env = makeEnv() as any;
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id } = await createResp.json() as any;

    // Force terminal state
    const inst = instances.get(id)!.instance as any;
    inst.transition("aborted", "test");

    const resp = await worker.fetch(new Request(
      `https://x/sessions/${id}/prompt`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }) },
    ), env);
    expect(resp.status).toBe(410);
    const body = await resp.json() as any;
    expect(body.recoverable).toBe(false);
  });

  it("sendPrompt with no connected runner + launcher URL → kind:'queued' (202) and stores pendingPrompt", async () => {
    const env = makeEnv() as any;
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id } = await createResp.json() as any;

    // No runner connected
    const resp = await worker.fetch(new Request(
      `https://x/sessions/${id}/prompt`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "follow up" }) },
    ), env);
    expect(resp.status).toBe(202);
    const body = await resp.json() as any;
    expect(body.queued).toBe(true);
    expect(body.recoverable).toBe(true);

    // pendingPrompt should be persisted
    const entry = instances.get(id)!;
    expect((entry.instance as any).session.pendingPrompt).toBe("follow up");
    const stored = entry.ctx.storage.kv.get("session") as any;
    expect(stored.pendingPrompt).toBe("follow up");
  });

  it("abort: runner gets session.shutdown command + state → aborted", async () => {
    const env = makeEnv() as any;
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id, runnerToken } = await createResp.json() as any;

    // Connect runner so it can receive the shutdown command
    const runnerResp = await worker.fetch(new Request(
      `https://x/sessions/${id}/runner?token=${runnerToken}`,
      { headers: { Upgrade: "websocket" } },
    ), env);
    const runnerWS = (runnerResp as any).webSocket as FakeWebSocket;
    const inbound: any[] = [];
    runnerWS.addEventListener("message", (e: any) => inbound.push(JSON.parse(e.data)));
    await new Promise(r => setTimeout(r, 5));

    const abortResp = await worker.fetch(new Request(
      `https://x/sessions/${id}/abort`, { method: "POST" }
    ), env);
    expect(abortResp.status).toBe(200);
    await new Promise(r => setTimeout(r, 5));

    const shutdownCmd = inbound.find(m => m.type === "command" && m.command?.type === "session.shutdown");
    expect(shutdownCmd).toBeDefined();

    const state = await env.SESSION_DO.get(env.SESSION_DO.idFromString(id)).getState();
    expect(state.session.status).toBe("aborted");
  });

  it("event replay on client reconnect: late client gets full history via type:'replay'", async () => {
    const env = makeEnv() as any;
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id } = await createResp.json() as any;

    // Wait so a few events are appended
    await new Promise(r => setTimeout(r, 5));

    // Connect client AFTER events exist
    const clientResp = await worker.fetch(new Request(
      `https://x/sessions/${id}/stream`,
      { headers: { Upgrade: "websocket" } },
    ), env);
    const ws = (clientResp as any).webSocket as FakeWebSocket;
    const inbound: any[] = [];
    ws.addEventListener("message", (e: any) => inbound.push(JSON.parse(e.data)));
    await new Promise(r => setTimeout(r, 5));

    const replay = inbound.find(m => m.type === "replay");
    expect(replay).toBeDefined();
    expect(replay.events.length).toBeGreaterThan(0);
    const sessionState = inbound.find(m => m.type === "session_state");
    expect(sessionState).toBeDefined();
  });

  it("WS attachment: lastSeq stored per-conn so re-broadcast doesn't double-send", async () => {
    const env = makeEnv() as any;
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id, runnerToken } = await createResp.json() as any;

    // Connect runner and client
    const runnerResp = await worker.fetch(new Request(
      `https://x/sessions/${id}/runner?token=${runnerToken}`,
      { headers: { Upgrade: "websocket" } },
    ), env);
    const runnerWS = (runnerResp as any).webSocket as FakeWebSocket;

    const clientResp = await worker.fetch(new Request(
      `https://x/sessions/${id}/stream`,
      { headers: { Upgrade: "websocket" } },
    ), env);
    const clientWS = (clientResp as any).webSocket as FakeWebSocket;

    await new Promise(r => setTimeout(r, 5));

    // Check attachments are populated
    const entry = instances.get(id)!;
    const allWS = entry.ctx.getWebSockets();
    expect(allWS.length).toBe(2);
    for (const ws of allWS) {
      const att = (ws as any).deserializeAttachment();
      expect(att).toBeDefined();
      expect(["client", "runner"]).toContain(att.tag);
      expect(typeof att.lastSeq).toBe("number");
    }
    // Attachments live on the server-side WS (the half DO holds via
    // ctx.acceptWebSocket). The caller-facing client/runner halves don't
    // carry them — use peerAttachment() to read the server half.
    const runnerTag = (runnerWS as any).peerAttachment();
    const clientTag = (clientWS as any).peerAttachment();
    expect(runnerTag.tag).toBe("runner");
    expect(clientTag.tag).toBe("client");
  });

  it("approve flow: runner emits approval.requested → POST /approve → runner gets approval.grant", async () => {
    const env = makeEnv() as any;
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id, runnerToken } = await createResp.json() as any;

    const runnerResp = await worker.fetch(new Request(
      `https://x/sessions/${id}/runner?token=${runnerToken}`,
      { headers: { Upgrade: "websocket" } },
    ), env);
    const runnerWS = (runnerResp as any).webSocket as FakeWebSocket;
    const inbound: any[] = [];
    runnerWS.addEventListener("message", (e: any) => inbound.push(JSON.parse(e.data)));
    await new Promise(r => setTimeout(r, 5));

    // Synthesize an approval request via DO API
    const inst = instances.get(id)!.instance as any;
    const requestId = inst.requestApproval("git.push", { what: "branch" });
    expect(requestId).toBeTruthy();

    const state1 = await env.SESSION_DO.get(env.SESSION_DO.idFromString(id)).getState();
    expect(state1.session.status).toBe("needs_approval");

    // Approve
    const approveResp = await worker.fetch(new Request(
      `https://x/sessions/${id}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) },
    ), env);
    expect(approveResp.status).toBe(200);
    await new Promise(r => setTimeout(r, 5));

    const grant = inbound.find(m => m.type === "command" && m.command?.type === "approval.grant");
    expect(grant).toBeDefined();
    expect(grant.command.payload.requestId).toBe(requestId);

    const state2 = await env.SESSION_DO.get(env.SESSION_DO.idFromString(id)).getState();
    expect(state2.session.status).toBe("running");
  });
  // ---- GitHub webhook route ----

  it("POST /webhooks/github: rejects missing secret with 503", async () => {
    const env = makeEnv() as any;
    delete env.GITHUB_WEBHOOK_SECRET;
    const resp = await worker.fetch(
      new Request("https://x/webhooks/github", {
        method: "POST",
        headers: { "x-github-event": "ping", "x-github-delivery": "d1" },
        body: "{}",
      }),
      env,
    );
    expect(resp.status).toBe(503);
  });

  it("POST /webhooks/github: rejects bad HMAC with 401", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    const resp = await worker.fetch(
      new Request("https://x/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "d2",
          "x-hub-signature-256": "sha256=" + "0".repeat(64),
        },
        body: '{"foo":"bar"}',
      }),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it("POST /webhooks/github: unknown PR (not in index) acks 200 with kind=unknown_pr", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    const payload = {
      action: "closed",
      number: 7,
      pull_request: {
        number: 7,
        html_url: "https://github.com/o/r/pull/7",
        state: "closed",
        merged: true,
        merged_at: "2026-06-26T00:00:00Z",
        base: { ref: "main" },
        head: { ref: "hermes/x" },
        user: { login: "alice" },
      },
      repository: { full_name: "o/r" },
      sender: { login: "alice" },
    };
    const body = JSON.stringify(payload);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode("supersecret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const buf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    const hex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const resp = await worker.fetch(
      new Request("https://x/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "d3",
          "x-hub-signature-256": "sha256=" + hex,
        },
        body,
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json).toMatchObject({ ok: true, kind: "unknown_pr" });
  });

  it("POST /webhooks/github: pull_request.closed(merged=true) -> session archived + index unregistered", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";

    // 1. Drive a session to `completed` with a registered PR.
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id, runnerToken } = await createResp.json() as any;
    const wsUrl = `https://x/sessions/${id}/runner?token=${runnerToken}`;
    const wsResp = await worker.fetch(new Request(wsUrl, { headers: { Upgrade: "websocket" } }), env);
    const ws = (wsResp as any).webSocket;
    const sendRunner = (m: any) => ws.send(JSON.stringify(m));

    await new Promise(r => setTimeout(r, 5));
    sendRunner({ type: "runner.event", sessionId: id, payload: { eventType: "agent.done", eventPayload: {} } });
    sendRunner({ type: "runner.complete", sessionId: id, payload: { summary: "ok", changedFiles: [] } });
    await new Promise(r => setTimeout(r, 10));
    await worker.fetch(new Request(`https://x/sessions/${id}/create-pr`, { method: "POST" }), env);
    await new Promise(r => setTimeout(r, 10));
    sendRunner({
      type: "runner.event",
      sessionId: id,
      payload: {
        eventType: "pr.created",
        eventPayload: { url: "https://github.com/o/r/pull/9", ownerLogin: "alice" },
      },
    });
    await new Promise(r => setTimeout(r, 10));
    // Confirm completed + indexed.
    const s1 = await env.SESSION_DO.get(env.SESSION_DO.idFromString(id)).getState();
    expect(s1.session.status).toBe("completed");
    expect(prIndexRows.get("o/r#9")?.sessionId).toBe(id);

    // 2. Sign + deliver a pull_request.closed (merged) webhook.
    const payload = {
      action: "closed",
      number: 9,
      pull_request: {
        number: 9,
        html_url: "https://github.com/o/r/pull/9",
        state: "closed", merged: true, merged_at: "2026-06-26T00:00:00Z",
        base: { ref: "main" }, head: { ref: "hermes/x" }, user: { login: "alice" },
      },
      repository: { full_name: "o/r" }, sender: { login: "alice" },
    };
    const body = JSON.stringify(payload);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode("supersecret"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const buf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");

    const resp = await worker.fetch(new Request("https://x/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "del-merged-1",
        "x-hub-signature-256": "sha256=" + hex,
      },
      body,
    }), env);
    expect(resp.status).toBe(200);
    const j = await resp.json();
    expect(j).toMatchObject({ ok: true, kind: "pull_request", archived: true });

    // Session state should be `archived`; PR row gone from the index.
    const s2 = await env.SESSION_DO.get(env.SESSION_DO.idFromString(id)).getState();
    expect(s2.session.status).toBe("archived");
    expect(prIndexRows.has("o/r#9")).toBe(false);
    // Event log records pr.merged with the delivery id.
    const merged = s2.events.find((e: any) => e.type === "pr.merged");
    expect(merged?.payload?.deliveryId).toBe("del-merged-1");
  });

  it("POST /webhooks/github: duplicate delivery is deduped (no second event, no extra transitions)", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";

    // Seed the PR index with an open PR for a fresh session.
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id, runnerToken } = await createResp.json() as any;
    const wsUrl = `https://x/sessions/${id}/runner?token=${runnerToken}`;
    const wsResp = await worker.fetch(new Request(wsUrl, { headers: { Upgrade: "websocket" } }), env);
    const ws = (wsResp as any).webSocket;
    await new Promise(r => setTimeout(r, 5));
    ws.send(JSON.stringify({ type: "runner.complete", sessionId: id, payload: { summary: "ok", changedFiles: [] } }));
    await new Promise(r => setTimeout(r, 10));
    await worker.fetch(new Request(`https://x/sessions/${id}/create-pr`, { method: "POST" }), env);
    await new Promise(r => setTimeout(r, 10));
    ws.send(JSON.stringify({
      type: "runner.event",
      sessionId: id,
      payload: {
        eventType: "pr.created",
        eventPayload: { url: "https://github.com/o/r/pull/11", ownerLogin: "alice" },
      },
    }));
    await new Promise(r => setTimeout(r, 10));

    // pr.closed (NOT merged) → emit one pr.closed, no archive.
    const payload = {
      action: "closed",
      number: 11,
      pull_request: {
        number: 11,
        html_url: "https://github.com/o/r/pull/11",
        state: "closed", merged: false, merged_at: null,
        base: { ref: "main" }, head: { ref: "hermes/x" }, user: { login: "alice" },
      },
      repository: { full_name: "o/r" }, sender: { login: "alice" },
    };
    const body = JSON.stringify(payload);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode("supersecret"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const buf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    const headers = {
      "x-github-event": "pull_request",
      "x-github-delivery": "del-dup-1",
      "x-hub-signature-256": "sha256=" + hex,
    };

    // First delivery: processed.
    const r1 = await worker.fetch(new Request("https://x/webhooks/github", { method: "POST", headers, body }), env);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, kind: "pull_request", archived: false });

    // Second delivery, same delivery id: deduped.
    const r2 = await worker.fetch(new Request("https://x/webhooks/github", { method: "POST", headers, body }), env);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ ok: true, kind: "duplicate" });

    // Event log still has exactly one pr.closed.
    const state = await env.SESSION_DO.get(env.SESSION_DO.idFromString(id)).getState();
    const closed = state.events.filter((e: any) => e.type === "pr.closed");
    expect(closed.length).toBe(1);
    // Session remains `completed` (not archived) because unmerged close.
    expect(state.session.status).toBe("completed");
    // Index row still present (closed-unmerged keeps the row).
    expect(prIndexRows.get("o/r#11")?.status).toBe("closed");
  });

  it("POST /webhooks/github: pull_request.reopened on a closed-unmerged PR flips index status back to open", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";

    // Seed a session with a registered PR.
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id, runnerToken } = await createResp.json() as any;
    const wsUrl = `https://x/sessions/${id}/runner?token=${runnerToken}`;
    const wsResp = await worker.fetch(new Request(wsUrl, { headers: { Upgrade: "websocket" } }), env);
    const ws = (wsResp as any).webSocket;
    await new Promise(r => setTimeout(r, 5));
    ws.send(JSON.stringify({ type: "runner.complete", sessionId: id, payload: { summary: "ok", changedFiles: [] } }));
    await new Promise(r => setTimeout(r, 10));
    await worker.fetch(new Request(`https://x/sessions/${id}/create-pr`, { method: "POST" }), env);
    await new Promise(r => setTimeout(r, 10));
    ws.send(JSON.stringify({
      type: "runner.event",
      sessionId: id,
      payload: {
        eventType: "pr.created",
        eventPayload: { url: "https://github.com/o/r/pull/19", ownerLogin: "alice" },
      },
    }));
    await new Promise(r => setTimeout(r, 10));

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode("supersecret"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sign = async (body: string) => {
      const buf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
      return "sha256=" + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    };

    // 1. closed-unmerged -> status="closed", row retained.
    const closedBody = JSON.stringify({
      action: "closed", number: 19,
      pull_request: {
        number: 19, html_url: "https://github.com/o/r/pull/19",
        state: "closed", merged: false, merged_at: null,
        base: { ref: "main" }, head: { ref: "hermes/x" }, user: { login: "alice" },
      },
      repository: { full_name: "o/r" }, sender: { login: "alice" },
    });
    const r1 = await worker.fetch(new Request("https://x/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "del-reopen-close",
        "x-hub-signature-256": await sign(closedBody),
      },
      body: closedBody,
    }), env);
    expect(r1.status).toBe(200);
    expect(prIndexRows.get("o/r#19")?.status).toBe("closed");

    // 2. reopened -> status flips back to "open".
    const reopenBody = JSON.stringify({
      action: "reopened", number: 19,
      pull_request: {
        number: 19, html_url: "https://github.com/o/r/pull/19",
        state: "open", merged: false, merged_at: null,
        base: { ref: "main" }, head: { ref: "hermes/x" }, user: { login: "alice" },
      },
      repository: { full_name: "o/r" }, sender: { login: "alice" },
    });
    const r2 = await worker.fetch(new Request("https://x/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "del-reopen-open",
        "x-hub-signature-256": await sign(reopenBody),
      },
      body: reopenBody,
    }), env);
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2).toMatchObject({ ok: true, kind: "pull_request", archived: false });
    expect(prIndexRows.get("o/r#19")?.status).toBe("open");
  });

  // ---- Worker GET /pr-index ----

  it("GET /pr-index?key=…: returns the row registered by onPRCreated", async () => {
    const env = makeEnv() as any;
    env.HERMES_LAUNCHER_SECRET = "launcher-secret";
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id, runnerToken } = await createResp.json() as any;
    const wsUrl = `https://x/sessions/${id}/runner?token=${runnerToken}`;
    const wsResp = await worker.fetch(new Request(wsUrl, { headers: { Upgrade: "websocket" } }), env);
    const ws = (wsResp as any).webSocket;
    await new Promise(r => setTimeout(r, 5));
    ws.send(JSON.stringify({ type: "runner.complete", sessionId: id, payload: { summary: "ok", changedFiles: [] } }));
    await new Promise(r => setTimeout(r, 10));
    await worker.fetch(new Request(`https://x/sessions/${id}/create-pr`, { method: "POST" }), env);
    await new Promise(r => setTimeout(r, 10));
    ws.send(JSON.stringify({
      type: "runner.event",
      sessionId: id,
      payload: { eventType: "pr.created", eventPayload: { url: "https://github.com/o/r/pull/13", ownerLogin: "alice" } },
    }));
    await new Promise(r => setTimeout(r, 10));

    const resp = await worker.fetch(new Request("https://x/pr-index?key=" + encodeURIComponent("o/r#13"), {
      headers: { "x-hermes-launcher-secret": "launcher-secret" },
    }), env);
    expect(resp.status).toBe(200);
    const { row } = (await resp.json()) as any;
    expect(row).toMatchObject({ prKey: "o/r#13", sessionId: id, ownerLogin: "alice", status: "open" });
  });

  it("GET /pr-index missing key -> 400", async () => {
    const env = makeEnv() as any;
    env.HERMES_LAUNCHER_SECRET = "launcher-secret";
    const resp = await worker.fetch(new Request("https://x/pr-index", {
      headers: { "x-hermes-launcher-secret": "launcher-secret" },
    }), env);
    expect(resp.status).toBe(400);
  });

  it("GET /pr-index unknown PR -> 404", async () => {
    const env = makeEnv() as any;
    env.HERMES_LAUNCHER_SECRET = "launcher-secret";
    const resp = await worker.fetch(new Request("https://x/pr-index?key=o/r%23999", {
      headers: { "x-hermes-launcher-secret": "launcher-secret" },
    }), env);
    expect(resp.status).toBe(404);
  });

  it("GET /pr-index without HERMES_LAUNCHER_SECRET set on Worker -> 503", async () => {
    const env = makeEnv() as any;
    delete env.HERMES_LAUNCHER_SECRET;
    const resp = await worker.fetch(new Request("https://x/pr-index?key=o/r%23999"), env);
    expect(resp.status).toBe(503);
  });

  it("GET /pr-index with missing or wrong secret header -> 401", async () => {
    const env = makeEnv() as any;
    env.HERMES_LAUNCHER_SECRET = "launcher-secret";
    const noHeader = await worker.fetch(new Request("https://x/pr-index?key=o/r%23999"), env);
    expect(noHeader.status).toBe(401);
    const wrong = await worker.fetch(new Request("https://x/pr-index?key=o/r%23999", {
      headers: { "x-hermes-launcher-secret": "nope" },
    }), env);
    expect(wrong.status).toBe(401);
  });

  // ---- DO getState surfaces repoUrl + baseBranch (consumed by launcher amend resolver) ----

  it("getState returns repoUrl + baseBranch from the profile", async () => {
    const env = makeEnv() as any;
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "p1",
        taskDescription: "t",
        repoUrl: "https://github.com/o/r",
        profile: { ...PROFILE, defaultBranch: "develop" },
      }),
    }), env);
    const { id } = await createResp.json() as any;
    const getResp = await worker.fetch(new Request(`https://x/sessions/${id}`), env);
    expect(getResp.status).toBe(200);
    const data = (await getResp.json()) as any;
    expect(data.repoUrl).toBe("https://github.com/o/r");
    expect(data.baseBranch).toBe("develop");
  });

  it("POST /webhooks/github: pull_request.synchronize does NOT emit pr.closed (only the `closed` action is a lifecycle event)", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";

    // Seed: create session + register PR via pr.created.
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id, runnerToken } = await createResp.json() as any;
    const wsUrl = `https://x/sessions/${id}/runner?token=${runnerToken}`;
    const wsResp = await worker.fetch(new Request(wsUrl, { headers: { Upgrade: "websocket" } }), env);
    const ws = (wsResp as any).webSocket;
    await new Promise(r => setTimeout(r, 5));
    ws.send(JSON.stringify({ type: "runner.complete", sessionId: id, payload: { summary: "ok", changedFiles: [] } }));
    await new Promise(r => setTimeout(r, 10));
    await worker.fetch(new Request(`https://x/sessions/${id}/create-pr`, { method: "POST" }), env);
    await new Promise(r => setTimeout(r, 10));
    ws.send(JSON.stringify({
      type: "runner.event",
      sessionId: id,
      payload: { eventType: "pr.created", eventPayload: { url: "https://github.com/o/r/pull/21", ownerLogin: "alice" } },
    }));
    await new Promise(r => setTimeout(r, 10));

    // synchronize delivery (NOT closed) — should be acked but produce
    // ZERO pr.closed events and leave index status untouched.
    const payload = {
      action: "synchronize",
      number: 21,
      pull_request: {
        number: 21,
        html_url: "https://github.com/o/r/pull/21",
        state: "open", merged: false, merged_at: null,
        base: { ref: "main" }, head: { ref: "hermes/x" }, user: { login: "alice" },
      },
      repository: { full_name: "o/r" }, sender: { login: "alice" },
    };
    const body = JSON.stringify(payload);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode("supersecret"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const buf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");

    const resp = await worker.fetch(new Request("https://x/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "del-sync-1",
        "x-hub-signature-256": "sha256=" + hex,
      },
      body,
    }), env);
    expect(resp.status).toBe(200);
    const j = await resp.json();
    expect(j).toMatchObject({ ok: true, kind: "pull_request", archived: false });

    // Index row is still `open`, NOT bumped to closed.
    expect(prIndexRows.get("o/r#21")?.status).toBe("open");

    // Event log has NO pr.closed / pr.merged events.
    const state = await env.SESSION_DO.get(env.SESSION_DO.idFromString(id)).getState();
    const lifecycle = state.events.filter((e: any) => e.type === "pr.closed" || e.type === "pr.merged");
    expect(lifecycle.length).toBe(0);
  });

  it("POST /webhooks/github: unknown PR (not Hermes-opened) is acked without dispatch", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";

    const payload = {
      action: "closed",
      number: 99,
      pull_request: {
        number: 99,
        html_url: "https://github.com/o/r/pull/99",
        state: "closed", merged: true, merged_at: "2026-06-26T00:00:00Z",
        base: { ref: "main" }, head: { ref: "feat/x" }, user: { login: "bob" },
      },
      repository: { full_name: "o/r" }, sender: { login: "bob" },
    };
    const body = JSON.stringify(payload);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode("supersecret"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const buf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");

    const resp = await worker.fetch(new Request("https://x/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "del-unknown",
        "x-hub-signature-256": "sha256=" + hex,
      },
      body,
    }), env);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ ok: true, kind: "unknown_pr" });
  });

  // ---- Auto-amend on reviewer feedback + CI failure ----

  // Helper that signs an arbitrary webhook body with the configured
  // secret + builds a Request. Centralizing this keeps the integration
  // tests below readable.
  async function postWebhook(env: any, event: string, deliveryId: string, payload: unknown): Promise<Response> {
    const body = JSON.stringify(payload);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(env.GITHUB_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const buf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    return worker.fetch(new Request("https://x/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": "sha256=" + hex,
      },
      body,
    }), env);
  }

  // Drives a session to `completed` with a registered PR.
  async function seedPr(env: any, prKey: string, prUrl: string): Promise<string> {
    const createResp = await worker.fetch(new Request("https://x/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "p1", taskDescription: "t", profile: PROFILE }),
    }), env);
    const { id, runnerToken } = await createResp.json() as any;
    const wsResp = await worker.fetch(
      new Request(`https://x/sessions/${id}/runner?token=${runnerToken}`, { headers: { Upgrade: "websocket" } }),
      env,
    );
    const ws = (wsResp as any).webSocket;
    await new Promise(r => setTimeout(r, 5));
    ws.send(JSON.stringify({ type: "runner.complete", sessionId: id, payload: { summary: "ok", changedFiles: [] } }));
    await new Promise(r => setTimeout(r, 10));
    await worker.fetch(new Request(`https://x/sessions/${id}/create-pr`, { method: "POST" }), env);
    await new Promise(r => setTimeout(r, 10));
    ws.send(JSON.stringify({
      type: "runner.event", sessionId: id,
      payload: { eventType: "pr.created", eventPayload: { url: prUrl, ownerLogin: "alice" } },
    }));
    await new Promise(r => setTimeout(r, 10));
    return id;
  }

  function reviewChangesPayload(prNumber: number, headSha: string, reviewer: string, body: string | null = "fix the loop") {
    return {
      action: "submitted",
      pull_request: {
        number: prNumber,
        html_url: `https://github.com/o/r/pull/${prNumber}`,
        state: "open",
        head: { sha: headSha, ref: "hermes/x" },
        base: { ref: "main" },
      },
      review: {
        id: 1,
        state: "changes_requested",
        body,
        user: { login: reviewer, type: "User" },
        submitted_at: "2026-06-26T00:00:00Z",
      },
      repository: { full_name: "o/r" },
      sender: { login: reviewer, type: "User" },
    };
  }

  function checkRunFailedPayload(prNumber: number, headSha: string, name: string, conclusion: "failure" | "timed_out" = "failure") {
    return {
      action: "completed",
      check_run: {
        id: 1, name, head_sha: headSha,
        status: "completed", conclusion,
        html_url: "https://github.com/o/r/runs/1",
        details_url: "https://github.com/o/r/actions/runs/1",
        pull_requests: [{ number: prNumber, head: { ref: "hermes/x", sha: headSha } }],
      },
      repository: { full_name: "o/r" },
      sender: { login: "github-actions[bot]", type: "Bot" },
    };
  }

  // Mock global fetch for the launcher call. Vitest does not auto-restore
  // between tests in the same file; manage manually.
  let savedFetch: typeof globalThis.fetch;
  function mockLauncher(handler: (req: Request) => Promise<Response>): void {
    savedFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      // Only intercept the launcher's /sessions; everything else goes to
      // the real fetch (none expected in these tests).
      if (url.host === "launcher.test" && url.pathname === "/sessions") {
        return handler(req);
      }
      return savedFetch(input, init);
    };
  }
  function restoreFetch(): void {
    if (savedFetch) globalThis.fetch = savedFetch;
  }

  it("review_changes_requested: claims slot, calls launcher, emits pr.autofix.triggered on parent", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    env.CONTROL_PLANE_LAUNCHER_URL = "http://launcher.test";
    const parentId = await seedPr(env, "o/r#42", "https://github.com/o/r/pull/42");

    let launcherCall: any = null;
    mockLauncher(async (req) => {
      launcherCall = await req.json();
      return new Response(JSON.stringify({ sessionId: "sess-amend-1", sandboxId: "sbx-1" }), { ...({ status: 201 }), headers: { "content-type": "application/json" } });
    });
    try {
      const resp = await postWebhook(env, "pull_request_review", "del-review-1",
        reviewChangesPayload(42, "sha-1", "reviewer1", "rename foo -> bar"));
      expect(resp.status).toBe(200);
      const body = await resp.json() as any;
      expect(body).toMatchObject({
        dispatched: true,
        newSessionId: "sess-amend-1",
        autofixCount: 1,
      });
    } finally { restoreFetch(); }

    // Launcher got parentSessionId + a built taskDescription that quotes the review body.
    expect(launcherCall).toMatchObject({ parentSessionId: parentId });
    expect(launcherCall.taskDescription).toContain("rename foo -> bar");
    expect(launcherCall.taskDescription).toContain("@reviewer1");

    // Parent session has a pr.autofix.triggered event.
    const state = await env.SESSION_DO.get(env.SESSION_DO.idFromString(parentId)).getState();
    const triggered = state.events.find((e: any) => e.type === "pr.autofix.triggered");
    expect(triggered.payload).toMatchObject({
      trigger: "review_changes_requested",
      deliveryId: "del-review-1",
      headSha: "sha-1",
      reviewerLogin: "reviewer1",
      newSessionId: "sess-amend-1",
    });

    // Slot is now held by the SPAWNED session id (transferAmendSlot).
    expect(prIndexRows.get("o/r#42")?.inflightSessionId).toBe("sess-amend-1");
    expect(prIndexRows.get("o/r#42")?.autofixCount).toBe(1);
  });

  it("review.approved / review.commented are ignored (no dispatch, no event)", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    env.CONTROL_PLANE_LAUNCHER_URL = "http://launcher.test";
    await seedPr(env, "o/r#43", "https://github.com/o/r/pull/43");

    let called = false;
    mockLauncher(async () => { called = true; return new Response(JSON.stringify({}), { ...({ status: 500 }), headers: { "content-type": "application/json" } }); });
    try {
      const approved = reviewChangesPayload(43, "sha-A", "reviewer2", "lgtm");
      (approved.review as any).state = "approved";
      const resp = await postWebhook(env, "pull_request_review", "del-rev-app", approved);
      expect(resp.status).toBe(200);
      const j = await resp.json() as any;
      expect(j).toMatchObject({ kind: "ignored" });
    } finally { restoreFetch(); }
    expect(called).toBe(false);
    expect(prIndexRows.get("o/r#43")?.inflightSessionId).toBeUndefined();
  });

  it("self-review (reviewer === ownerLogin) is skipped with skipReason=self_review", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    env.CONTROL_PLANE_LAUNCHER_URL = "http://launcher.test";
    const parentId = await seedPr(env, "o/r#44", "https://github.com/o/r/pull/44");

    let called = false;
    mockLauncher(async () => { called = true; return new Response(JSON.stringify({}), { ...({ status: 500 }), headers: { "content-type": "application/json" } }); });
    try {
      const resp = await postWebhook(env, "pull_request_review", "del-rev-self",
        reviewChangesPayload(44, "sha-self", "alice", "i had second thoughts"));
      expect(resp.status).toBe(200);
      expect((await resp.json() as any).reason).toBe("self_review");
    } finally { restoreFetch(); }
    expect(called).toBe(false);
    const state = await env.SESSION_DO.get(env.SESSION_DO.idFromString(parentId)).getState();
    const ev = state.events.find((e: any) => e.type === "pr.autofix.skipped");
    expect(ev.payload.skipReason).toBe("self_review");
  });

  it("check_run.failure: dispatches with built taskDescription including detailsUrl", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    env.CONTROL_PLANE_LAUNCHER_URL = "http://launcher.test";
    const parentId = await seedPr(env, "o/r#45", "https://github.com/o/r/pull/45");

    let launcherCall: any = null;
    mockLauncher(async (req) => {
      launcherCall = await req.json();
      return new Response(JSON.stringify({ sessionId: "sess-cr-1", sandboxId: "sbx-2" }), { ...({ status: 201 }), headers: { "content-type": "application/json" } });
    });
    try {
      const resp = await postWebhook(env, "check_run", "del-cr-1",
        checkRunFailedPayload(45, "sha-cr", "ci / unit"));
      const j = await resp.json() as any;
      expect(j).toMatchObject({ dispatched: true, newSessionId: "sess-cr-1" });
    } finally { restoreFetch(); }
    expect(launcherCall.parentSessionId).toBe(parentId);
    expect(launcherCall.taskDescription).toContain("ci / unit");
    expect(launcherCall.taskDescription).toContain("https://github.com/o/r/actions/runs/1");
    const state = await env.SESSION_DO.get(env.SESSION_DO.idFromString(parentId)).getState();
    const ev = state.events.find((e: any) => e.type === "pr.autofix.triggered");
    expect(ev.payload.checkName).toBe("ci / unit");
  });

  it("cap_exceeded: 4th trigger after 3 successful amends is rejected", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    env.CONTROL_PLANE_LAUNCHER_URL = "http://launcher.test";
    const parentId = await seedPr(env, "o/r#46", "https://github.com/o/r/pull/46");

    let n = 0;
    mockLauncher(async () => {
      n++;
      return new Response(JSON.stringify({ sessionId: `sess-cap-${n}`, sandboxId: `sbx-${n}` }), { ...({ status: 201 }), headers: { "content-type": "application/json" } });
    });
    try {
      for (let i = 1; i <= 3; i++) {
        const resp = await postWebhook(env, "pull_request_review", `del-cap-${i}`,
          reviewChangesPayload(46, `sha-cap-${i}`, "rev"));
        const j = await resp.json() as any;
        expect(j.dispatched).toBe(true);
        // simulate spawned session reaching terminal so the next claim can succeed
        prIndexRows.get("o/r#46")!.inflightAmendStartedAt = undefined;
        prIndexRows.get("o/r#46")!.inflightSessionId = undefined;
      }
      const resp = await postWebhook(env, "pull_request_review", "del-cap-4",
        reviewChangesPayload(46, "sha-cap-4", "rev"));
      const j = await resp.json() as any;
      expect(j).toMatchObject({ dispatched: false, reason: "cap_exceeded" });
    } finally { restoreFetch(); }
    expect(n).toBe(3);
    const state = await env.SESSION_DO.get(env.SESSION_DO.idFromString(parentId)).getState();
    const triggered = state.events.filter((e: any) => e.type === "pr.autofix.triggered");
    const skipped = state.events.filter((e: any) => e.type === "pr.autofix.skipped");
    expect(triggered.length).toBe(3);
    expect(skipped.length).toBe(1);
    expect(skipped[0].payload.skipReason).toBe("cap_exceeded");
  });

  it("duplicate_sha: second review on the same head sha is skipped", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    env.CONTROL_PLANE_LAUNCHER_URL = "http://launcher.test";
    await seedPr(env, "o/r#47", "https://github.com/o/r/pull/47");

    mockLauncher(async () => new Response(JSON.stringify({ sessionId: "sess-dup-1", sandboxId: "sbx-d" }), { ...({ status: 201 }), headers: { "content-type": "application/json" } }));
    try {
      const r1 = await postWebhook(env, "pull_request_review", "del-dup-1",
        reviewChangesPayload(47, "sha-X", "rev"));
      expect((await r1.json() as any).dispatched).toBe(true);
      // Pretend the first amend finished, releasing the slot.
      prIndexRows.get("o/r#47")!.inflightAmendStartedAt = undefined;
      prIndexRows.get("o/r#47")!.inflightSessionId = undefined;
      // Same head sha (e.g. reviewer re-submits): refused.
      const r2 = await postWebhook(env, "pull_request_review", "del-dup-2",
        reviewChangesPayload(47, "sha-X", "rev"));
      expect(await r2.json()).toMatchObject({ dispatched: false, reason: "duplicate_sha" });
    } finally { restoreFetch(); }
  });

  it("inflight: concurrent triggers — second is refused while first is running", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    env.CONTROL_PLANE_LAUNCHER_URL = "http://launcher.test";
    await seedPr(env, "o/r#48", "https://github.com/o/r/pull/48");

    mockLauncher(async () => new Response(JSON.stringify({ sessionId: "sess-inf-1", sandboxId: "sbx-i" }), { ...({ status: 201 }), headers: { "content-type": "application/json" } }));
    try {
      const r1 = await postWebhook(env, "pull_request_review", "del-inf-1",
        reviewChangesPayload(48, "sha-A", "rev"));
      expect((await r1.json() as any).dispatched).toBe(true);
      // First still inflight (we did NOT clear it). Second must be refused.
      const r2 = await postWebhook(env, "check_run", "del-inf-2",
        checkRunFailedPayload(48, "sha-B", "ci"));
      expect(await r2.json()).toMatchObject({ dispatched: false, reason: "inflight" });
    } finally { restoreFetch(); }
  });

  it("launcher unreachable: slot is released so next trigger can retry", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    env.CONTROL_PLANE_LAUNCHER_URL = "http://launcher.test";
    await seedPr(env, "o/r#49", "https://github.com/o/r/pull/49");

    let callCount = 0;
    mockLauncher(async () => {
      callCount++;
      if (callCount === 1) return new Response(JSON.stringify({ error: "boom" }), { ...({ status: 500 }), headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ sessionId: "sess-r-1", sandboxId: "sbx-r" }), { ...({ status: 201 }), headers: { "content-type": "application/json" } });
    });
    try {
      const r1 = await postWebhook(env, "pull_request_review", "del-recover-1",
        reviewChangesPayload(49, "sha-A", "rev"));
      expect(await r1.json()).toMatchObject({ dispatched: false, reason: "launcher_500" });
      // Rollback must have cleared autofixCount + lastAmendedSha so a
      // retry on the SAME sha is allowed.
      expect(prIndexRows.get("o/r#49")?.autofixCount).toBe(0);
      expect(prIndexRows.get("o/r#49")?.lastAmendedSha).toBeUndefined();
      const r2 = await postWebhook(env, "pull_request_review", "del-recover-2",
        reviewChangesPayload(49, "sha-A", "rev"));
      expect((await r2.json() as any).dispatched).toBe(true);
    } finally { restoreFetch(); }
    expect(callCount).toBe(2);
  });

  it("launcher 2xx without sessionId: rollback claim + dispatched=false (slot not stuck)", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    env.CONTROL_PLANE_LAUNCHER_URL = "http://launcher.test";
    await seedPr(env, "o/r#52", "https://github.com/o/r/pull/52");

    // Launcher returns 200 OK but the body has no sessionId — could be a
    // misconfigured launcher, a proxy injecting a static page, etc.
    mockLauncher(async () => new Response(JSON.stringify({ ok: true }), {
      ...({ status: 200 }), headers: { "content-type": "application/json" },
    }));
    try {
      const r1 = await postWebhook(env, "pull_request_review", "del-nosess-1",
        reviewChangesPayload(52, "sha-N", "rev"));
      expect(await r1.json()).toMatchObject({ dispatched: false, reason: "launcher_no_session_id" });
      // Slot must be fully released (no inflight, autofixCount rolled back,
      // lastAmendedSha cleared) so a retry on the same sha is allowed.
      const row = prIndexRows.get("o/r#52");
      expect(row?.inflightAmendStartedAt).toBeUndefined();
      expect(row?.inflightSessionId).toBeUndefined();
      expect(row?.autofixCount).toBe(0);
      expect(row?.lastAmendedSha).toBeUndefined();
    } finally { restoreFetch(); }

    // Second attempt with a real sessionId succeeds (proves the slot is
    // fully reclaimable after the no-sessionId rollback).
    mockLauncher(async () => new Response(JSON.stringify({ sessionId: "sess-recover", sandboxId: "sbx" }), {
      ...({ status: 201 }), headers: { "content-type": "application/json" },
    }));
    try {
      const r2 = await postWebhook(env, "pull_request_review", "del-nosess-2",
        reviewChangesPayload(52, "sha-N", "rev"));
      expect((await r2.json() as any).dispatched).toBe(true);
    } finally { restoreFetch(); }
  });

  it("CONTROL_PLANE_LAUNCHER_URL unset: skip with reason=launcher_not_configured", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    delete env.CONTROL_PLANE_LAUNCHER_URL;
    const parentId = await seedPr(env, "o/r#50", "https://github.com/o/r/pull/50");
    const resp = await postWebhook(env, "pull_request_review", "del-no-launch",
      reviewChangesPayload(50, "sha-N", "rev"));
    expect(await resp.json()).toMatchObject({ dispatched: false, reason: "launcher_not_configured" });
    const state = await env.SESSION_DO.get(env.SESSION_DO.idFromString(parentId)).getState();
    const skipped = state.events.find((e: any) => e.type === "pr.autofix.skipped");
    expect(skipped.payload.skipReason).toBe("launcher_not_configured");
  });

  it("HERMES_AUTOFIX_CAP env override is honored", async () => {
    const env = makeEnv() as any;
    env.GITHUB_WEBHOOK_SECRET = "supersecret";
    env.CONTROL_PLANE_LAUNCHER_URL = "http://launcher.test";
    env.HERMES_AUTOFIX_CAP = "1";
    await seedPr(env, "o/r#51", "https://github.com/o/r/pull/51");
    mockLauncher(async () => new Response(JSON.stringify({ sessionId: "sess-x", sandboxId: "sbx-x" }), { ...({ status: 201 }), headers: { "content-type": "application/json" } }));
    try {
      const r1 = await postWebhook(env, "pull_request_review", "del-cap1-1",
        reviewChangesPayload(51, "sha-1", "rev"));
      expect((await r1.json() as any).dispatched).toBe(true);
      prIndexRows.get("o/r#51")!.inflightAmendStartedAt = undefined;
      prIndexRows.get("o/r#51")!.inflightSessionId = undefined;
      const r2 = await postWebhook(env, "pull_request_review", "del-cap1-2",
        reviewChangesPayload(51, "sha-2", "rev"));
      expect(await r2.json()).toMatchObject({ dispatched: false, reason: "cap_exceeded" });
    } finally { restoreFetch(); }
  });
});
