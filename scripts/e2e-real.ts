// ============================================================
// Real E2E driver — runs against a live `wrangler dev` instance.
//
// Usage (separate terminal from `bunx wrangler dev`):
//   bun run scripts/e2e-real.ts
//   bun run scripts/e2e-real.ts http://localhost:8787   # explicit URL
//
// Exits 0 if all scenarios pass, 1 otherwise. Each step prints
// PASS/FAIL with a one-line reason.
// ============================================================

import { WebSocket } from "ws";
import { spawn, type ChildProcess } from "node:child_process";

const BASE = process.argv[2] ?? "http://localhost:8787";
const WS_BASE = BASE.replace(/^http/, "ws");

// ---- Assertion harness ----

let passed = 0;
let failed = 0;
const failures: string[] = [];

function pass(name: string, detail = "") {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  failed++;
  failures.push(`${name}: ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name} — ${detail}`);
}
function section(title: string) {
  console.log(`\n\x1b[1m▸ ${title}\x1b[0m`);
}
function assert(cond: unknown, name: string, detail = ""): asserts cond {
  if (cond) pass(name, detail);
  else {
    fail(name, detail || "assertion failed");
    throw new Error(`step failed: ${name}`);
  }
}

// ---- HTTP helpers ----

async function http<T = any>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  // Build init incrementally — fetch rejects `body` (even `undefined`) on GET.
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(`${BASE}${path}`, init);
  const text = await resp.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: resp.status, body: parsed };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Wait for a predicate against repeated /sessions/:id GETs.
async function waitForState(
  sessionId: string,
  predicate: (state: any) => boolean,
  opts: { timeoutMs?: number; label: string },
): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const start = Date.now();
  let last: any = null;
  while (Date.now() - start < timeoutMs) {
    const r = await http("GET", `/sessions/${sessionId}`);
    last = r.body;
    if (r.status === 200 && predicate(r.body)) return r.body;
    await sleep(150);
  }
  throw new Error(
    `waitForState timed out (${opts.label}); last status=${last?.session?.status} events=${last?.events?.length ?? 0}`,
  );
}

// ---- Fake runner driver (in-process, no child) ----

interface FakeRunnerOptions {
  sessionId: string;
  token: string;
  autoCompleteOnPrompt?: boolean; // emit runner.complete with artifacts after a prompt
  autoPRCreated?: boolean;        // emit pr.created on pr.create command
}

function startFakeRunner(opts: FakeRunnerOptions): {
  ws: WebSocket;
  ready: Promise<void>;
  commandsReceived: any[];
  close: () => void;
} {
  const url = new URL(`${WS_BASE}/sessions/${opts.sessionId}/runner`);
  url.searchParams.set("token", opts.token);
  const ws = new WebSocket(url.toString());
  const commandsReceived: any[] = [];
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(e));
  });

  ws.on("open", () => {
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "runner.heartbeat", sessionId: opts.sessionId }));
      }
    }, 5000);
  });

  ws.on("message", async (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== "command" || !msg.command) return;

    const cmd = msg.command;
    commandsReceived.push(cmd);
    // Ack
    ws.send(JSON.stringify({
      type: "runner.command_ack",
      sessionId: opts.sessionId,
      payload: { commandId: cmd.commandId },
    }));

    if (cmd.type === "agent.prompt" && opts.autoCompleteOnPrompt) {
      // Simulate a tiny stream then complete.
      ws.send(JSON.stringify({
        type: "runner.event",
        sessionId: opts.sessionId,
        payload: { eventType: "agent.message.delta", eventPayload: { text: "working..." } },
      }));
      await sleep(100);
      ws.send(JSON.stringify({
        type: "runner.complete",
        sessionId: opts.sessionId,
        payload: {
          summary: "e2e test summary",
          diff: "diff --git a/x b/x\n+++ b/x\n@@ +e2e",
          changedFiles: ["x"],
          testResult: { passed: true, total: 1, failed: 0, output: "ok" },
        },
      }));
    }
    if (cmd.type === "pr.create" && opts.autoPRCreated) {
      await sleep(100);
      ws.send(JSON.stringify({
        type: "runner.event",
        sessionId: opts.sessionId,
        payload: { eventType: "pr.created", eventPayload: { url: "https://github.com/e2e/test/pull/42" } },
      }));
      ws.send(JSON.stringify({
        type: "runner.complete",
        sessionId: opts.sessionId,
        payload: { prUrl: "https://github.com/e2e/test/pull/42" },
      }));
    }
    if (cmd.type === "session.shutdown") {
      if (heartbeat) clearInterval(heartbeat);
      ws.close(1000, "shutdown");
    }
  });

  return {
    ws,
    ready,
    commandsReceived,
    close: () => { if (heartbeat) clearInterval(heartbeat); ws.close(); },
  };
}

// ---- Client-side event stream collector ----

function subscribeClient(sessionId: string): {
  ws: WebSocket;
  ready: Promise<void>;
  messages: any[];
  close: () => void;
} {
  const ws = new WebSocket(`${WS_BASE}/sessions/${sessionId}/stream`);
  const messages: any[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (raw: Buffer) => {
    try { messages.push(JSON.parse(raw.toString())); } catch {}
  });
  return { ws, ready, messages, close: () => ws.close() };
}

// ---- Scenarios ----

async function scenarioHealth() {
  section("Health check");
  const r = await http<{ status: string }>("GET", "/health");
  assert(r.status === 200, "GET /health → 200", `got ${r.status}`);
  assert(r.body.status === "ok", "body.status === 'ok'", JSON.stringify(r.body));
}

async function scenarioCreateAndGet() {
  section("Create session via POST /sessions (RPC under the hood)");
  const r = await http<any>("POST", "/sessions", {
    projectId: "e2e",
    taskDescription: "e2e real test",
    // omit repoUrl so provisionSandbox skips (no E2B call)
    profile: { name: "e2e", defaultBranch: "main", model: "test", allowedTools: ["read"] },
  });
  assert(r.status === 201, "POST /sessions → 201", `got ${r.status}, body=${JSON.stringify(r.body).slice(0,200)}`);
  assert(typeof r.body.id === "string" && r.body.id.length > 0, "response.id is a string");
  assert(r.body.status === "created", "response.status === 'created'", r.body.status);
  assert(typeof r.body.runnerToken === "string", "response.runnerToken present");

  section("GET /sessions/:id returns session + events");
  const g = await http<any>("GET", `/sessions/${r.body.id}`);
  assert(g.status === 200, "GET /sessions/:id → 200");
  assert(g.body.session?.id === r.body.id, "state.session.id matches");
  assert(Array.isArray(g.body.events) && g.body.events.length >= 1, "events array non-empty");
  assert(
    g.body.events.some((e: any) => e.type === "session.created"),
    "session.created event present",
  );

  section("GET unknown session → 404");
  const nf = await http<any>("GET", "/sessions/nonexistentXYZ");
  assert(nf.status === 404, "404 on unknown id", `got ${nf.status}`);

  return { sessionId: r.body.id as string, runnerToken: r.body.runnerToken as string };
}

async function scenarioInvalidRunnerToken(sessionId: string) {
  section("Runner WS with invalid token → close(4001)");
  const url = new URL(`${WS_BASE}/sessions/${sessionId}/runner`);
  url.searchParams.set("token", "WRONG_TOKEN");
  const ws = new WebSocket(url.toString());
  const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.once("error", reject);
    setTimeout(() => reject(new Error("WS close timeout")), 5000);
  });
  assert(closed.code === 4001, "close code = 4001", `got ${closed.code} (${closed.reason})`);
}

async function scenarioHappyPath() {
  section("Happy path: create → client subs → runner connects → agent runs → review_ready → create-pr → completed");

  // Create
  const create = await http<any>("POST", "/sessions", {
    projectId: "e2e-happy",
    taskDescription: "implement happy-path E2E",
    profile: { name: "e2e", defaultBranch: "main", model: "test", allowedTools: ["read"] },
  });
  assert(create.status === 201, "create → 201");
  const sessionId = create.body.id;
  const token = create.body.runnerToken;

  // Subscribe client
  const client = subscribeClient(sessionId);
  await client.ready;
  pass("client WS subscribed");

  // Start fake runner with auto-complete + auto-PR
  const runner = startFakeRunner({
    sessionId,
    token,
    autoCompleteOnPrompt: true,
    autoPRCreated: true,
  });
  await runner.ready;
  pass("runner WS connected with valid token");

  // Wait for review_ready (after autoCompleteOnPrompt)
  const stateReview = await waitForState(
    sessionId,
    (s) => s.session?.status === "review_ready",
    { label: "review_ready", timeoutMs: 8000 },
  );
  pass("state reached review_ready", `events=${stateReview.events.length}`);
  assert(stateReview.artifacts?.summary === "e2e test summary", "artifacts.summary persisted");
  assert(stateReview.artifacts?.diff?.includes("e2e"), "artifacts.diff persisted");

  // Verify runner received the initial agent.prompt command
  assert(
    runner.commandsReceived.some(
      (c) => c.type === "agent.prompt" && c.payload.taskDescription === "implement happy-path E2E",
    ),
    "runner received agent.prompt command",
  );

  // Verify client got broadcast events (replay + live)
  const clientHasAgentMsg = client.messages.some(
    (m) => m.type === "event" && m.event?.type === "agent.message.delta",
  );
  assert(clientHasAgentMsg, "client received agent.message.delta broadcast");

  // Trigger PR creation
  const pr = await http<any>("POST", `/sessions/${sessionId}/create-pr`);
  assert(pr.status === 200, "POST /create-pr → 200");

  // Wait for completed + prUrl
  const stateDone = await waitForState(
    sessionId,
    (s) => s.session?.status === "completed",
    { label: "completed", timeoutMs: 6000 },
  );
  pass("state reached completed");
  assert(
    stateDone.artifacts?.prUrl === "https://github.com/e2e/test/pull/42",
    "artifacts.prUrl is the PR URL emitted by runner",
  );

  // Verify pr.created event broadcast to client
  const clientGotPR = client.messages.some(
    (m) => m.type === "event" && m.event?.type === "pr.created",
  );
  assert(clientGotPR, "client received pr.created event");

  runner.close();
  client.close();
}

async function scenarioEventLogPersistAndReplay() {
  section("Event log persisted per-key + client reconnect gets full replay");

  const create = await http<any>("POST", "/sessions", {
    projectId: "e2e-replay",
    taskDescription: "test replay",
    profile: { name: "e2e", defaultBranch: "main", model: "test", allowedTools: ["read"] },
  });
  const sessionId = create.body.id;

  // Give DO time to persist the initial session.created event
  await sleep(200);

  // First client connects, gets replay
  const c1 = subscribeClient(sessionId);
  await c1.ready;
  await sleep(300);

  const replay1 = c1.messages.find((m) => m.type === "replay");
  assert(replay1, "first client got replay frame");
  assert(replay1.events.length >= 1, "replay has at least session.created", `got ${replay1.events.length}`);
  const sessionState = c1.messages.find((m) => m.type === "session_state");
  assert(sessionState?.session?.id === sessionId, "session_state frame present with matching id");

  c1.close();

  // Second client connects later — should still receive full replay
  // (validates events live in DO storage, not just memory)
  await sleep(200);
  const c2 = subscribeClient(sessionId);
  await c2.ready;
  await sleep(300);
  const replay2 = c2.messages.find((m) => m.type === "replay");
  assert(replay2, "second client also got replay (events persisted)");
  assert(
    replay2.events.length >= replay1.events.length,
    "second replay has same/more events than first",
    `first=${replay1.events.length} second=${replay2.events.length}`,
  );
  c2.close();
}

async function scenarioPromptQueuedWhenRunnerOffline() {
  section("POST /prompt with no runner → 202 queued (pendingPrompt stored)");

  const create = await http<any>("POST", "/sessions", {
    projectId: "e2e-queued",
    taskDescription: "test queued prompt",
    profile: { name: "e2e", defaultBranch: "main", model: "test", allowedTools: ["read"] },
  });
  const sessionId = create.body.id;
  await sleep(100);

  const r = await http<any>("POST", `/sessions/${sessionId}/prompt`, { text: "follow up while offline" });
  // Either 202 (resume configured) or 409 (no launcher URL). Accept both as valid.
  assert(r.status === 202 || r.status === 409, "prompt got 202 or 409", `status=${r.status} body=${JSON.stringify(r.body)}`);
  if (r.status === 202) {
    assert(r.body.queued === true, "body.queued === true");
    assert(r.body.recoverable === true, "body.recoverable === true");
  } else {
    assert(r.body.recoverable === false, "body.recoverable === false (no launcher)");
  }
}

async function scenarioAbort() {
  section("POST /abort terminates session and sends session.shutdown to runner");

  const create = await http<any>("POST", "/sessions", {
    projectId: "e2e-abort",
    taskDescription: "test abort",
    profile: { name: "e2e", defaultBranch: "main", model: "test", allowedTools: ["read"] },
  });
  const sessionId = create.body.id;
  const token = create.body.runnerToken;

  // Connect runner so it can receive the shutdown command
  const runner = startFakeRunner({ sessionId, token });
  await runner.ready;
  await sleep(200);

  const r = await http<any>("POST", `/sessions/${sessionId}/abort`);
  assert(r.status === 200, "/abort → 200");

  await sleep(500);
  const shutdown = runner.commandsReceived.find((c) => c.type === "session.shutdown");
  assert(shutdown, "runner received session.shutdown command");

  const state = await http<any>("GET", `/sessions/${sessionId}`);
  assert(state.body.session.status === "aborted", "session.status === aborted", state.body.session.status);

  runner.close();
}

async function scenarioPromptOnTerminal() {
  section("POST /prompt on terminal session → 410 not recoverable");

  // Reuse abort scenario approach: create + abort, then prompt
  const create = await http<any>("POST", "/sessions", {
    projectId: "e2e-terminal",
    taskDescription: "test terminal prompt",
    profile: { name: "e2e", defaultBranch: "main", model: "test", allowedTools: ["read"] },
  });
  const sessionId = create.body.id;
  await sleep(100);
  await http("POST", `/sessions/${sessionId}/abort`);
  await sleep(300);

  const r = await http<any>("POST", `/sessions/${sessionId}/prompt`, { text: "too late" });
  assert(r.status === 410, "prompt on terminal → 410", `got ${r.status}`);
  assert(r.body.recoverable === false, "recoverable === false");
}

// ---- Main ----

async function main() {
  console.log(`\x1b[1mHermes Control Plane — Real E2E\x1b[0m`);
  console.log(`Target: ${BASE}\n`);

  try {
    // Preflight
    try {
      await http("GET", "/health");
    } catch (e) {
      console.error(`\n\x1b[31m✗\x1b[0m Cannot reach ${BASE}.`);
      console.error(`  Is \`bunx wrangler dev\` running?`);
      console.error(`  Original error: ${(e as Error).message}`);
      process.exit(2);
    }

    await scenarioHealth();
    const created = await scenarioCreateAndGet();
    await scenarioInvalidRunnerToken(created.sessionId);
    await scenarioHappyPath();
    await scenarioEventLogPersistAndReplay();
    await scenarioPromptQueuedWhenRunnerOffline();
    await scenarioAbort();
    await scenarioPromptOnTerminal();
  } catch (e) {
    // Step-failure already logged; continue to summary.
  }

  console.log(`\n\x1b[1mSummary:\x1b[0m ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\n\x1b[31mFailures:\x1b[0m");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("\x1b[32mAll E2E scenarios passed.\x1b[0m");
}

await main();
