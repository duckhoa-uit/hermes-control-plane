// Standalone runner that runs inside the E2B sandbox. Bundled into
// /opt/hermes/runner.js by infra/e2b/build-template.ts and execed by the
// supervisor once per-session secrets arrive.
//
// M4 shape:
//   - Connects WS back to the SessionDurableObject (unchanged).
//   - Owns an OpencodeClient against the locally-running `opencode serve`
//     (the supervisor already started it; URL is OPENCODE_BASE_URL).
//   - On agent.prompt command:
//       1. Lazily creates an opencode session bound to /home/user/repo
//          (first turn) or reuses the same id (follow-up turns).
//       2. Spawns an SSE subscriber against /event?directory=REPO_DIR;
//          maps OpenCode events to Hermes event types and bridges them
//          over WS to the DO.
//       3. Calls `session.prompt` (blocking HTTP) — when it returns, the
//          turn is done; emits `runner.complete` with the AssistantMessage
//          tokens/cost as agent.usage.
//   - On pr.create command: unchanged (git push + REST).

import { WebSocket } from "ws";
import { exec as execCb } from "child_process";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { createEventMapper } from "./event-mapper";

const SESSION_ID = process.env.HERMES_SESSION_ID;
const RUNNER_TOKEN = process.env.HERMES_RUNNER_TOKEN;
const CONTROL_WS = process.env.HERMES_CONTROL_WS;
const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096";
const MODEL_ID = process.env.OPENCODE_MODEL_ID || "glm-5.2";
const PROVIDER_ID = process.env.OPENCODE_PROVIDER_ID || "zai-coding-plan";
const REPO_DIR = "/home/user/repo";

// §12.17 — Hermes runs unattended; pre-declare every tool as allowed so
// opencode never blocks on permission.asked. The default "build" agent
// allows "*" but adds edge-case asks (.env files, external_directory).
// Passing `tools` in session.prompt body builds explicit allow rules per
// tool with pattern "*", overriding the agent default + any user
// opencode.json in the cloned repo (per packages/opencode/src/session/prompt.ts:1163).
const ALLOW_ALL_TOOLS: Record<string, boolean> = {
  read: true,
  edit: true,
  write: true,
  bash: true,
  grep: true,
  glob: true,
  list: true,
  webfetch: true,
  websearch: true,
  todowrite: true,
  task: true,
};

if (!SESSION_ID || !RUNNER_TOKEN || !CONTROL_WS) {
  console.error("Missing required env vars (HERMES_SESSION_ID, HERMES_RUNNER_TOKEN, HERMES_CONTROL_WS)");
  process.exit(1);
}

const wsBaseUrl = CONTROL_WS
  .replace(/^http:\/\//, "ws://")
  .replace(/^https:\/\//, "wss://")
  .replace(/\/$/, "");
const wsUrl = wsBaseUrl + "/sessions/" + SESSION_ID + "/runner?token=" + RUNNER_TOKEN;

console.log("[runner] Initial connect to:", wsUrl);

// WebSocket manager — owns reconnect loop. Spec (M5 §12.14):
//   - exp backoff 500ms, 1s, 2s, 4s, 8s, cap 15s, total budget 60s
//   - re-read /opt/hermes/start.json on each retry so a rotated runner
//     token (M5 follow-up) is picked up
//   - if budget exhausts, exit(1) so the supervisor babysit chain tears
//     the sandbox down cleanly
import { readFileSync as fsReadFileSync, existsSync as fsExistsSync } from "fs";
const RECONNECT_BACKOFFS_MS = [500, 1000, 2000, 4000, 8000, 15000];
const RECONNECT_TOTAL_BUDGET_MS = 60000;
let ws: WebSocket = new WebSocket(wsUrl);
let heartbeat: ReturnType<typeof setInterval> | null = null;
let reconnecting = false;
let shuttingDown = false;

function refreshWsUrl(): string {
  // Re-read start.json so a rotated runner token (post-resume) is used.
  try {
    if (fsExistsSync("/opt/hermes/start.json")) {
      const cfg = JSON.parse(fsReadFileSync("/opt/hermes/start.json", "utf-8")) as Record<string, string>;
      const tok = cfg.HERMES_RUNNER_TOKEN;
      const cws = cfg.HERMES_CONTROL_WS;
      if (tok && cws) {
        const base = cws.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://").replace(/\/$/, "");
        return `${base}/sessions/${SESSION_ID}/runner?token=${tok}`;
      }
    }
  } catch {}
  return wsUrl; // fall back to initial
}

async function reconnect(): Promise<void> {
  if (reconnecting || shuttingDown) return;
  reconnecting = true;
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < RECONNECT_TOTAL_BUDGET_MS) {
    const delay = RECONNECT_BACKOFFS_MS[Math.min(attempt, RECONNECT_BACKOFFS_MS.length - 1)];
    await new Promise((r) => setTimeout(r, delay));
    attempt++;
    const url = refreshWsUrl();
    console.log(`[runner] reconnect attempt ${attempt} -> ${url.slice(0, 80)}…`);
    try {
      const next = new WebSocket(url);
      const ok = await new Promise<boolean>((resolve) => {
        const onOpen = () => { cleanup(); resolve(true); };
        const onErr = () => { cleanup(); resolve(false); };
        const onClose = () => { cleanup(); resolve(false); };
        const cleanup = () => {
          next.off("open", onOpen);
          next.off("error", onErr);
          next.off("close", onClose);
        };
        next.on("open", onOpen);
        next.on("error", onErr);
        next.on("close", onClose);
      });
      if (ok) {
        console.log(`[runner] reconnect succeeded on attempt ${attempt} (${Date.now() - startedAt}ms)`);
        ws = next;
        attachHandlers();
        reconnecting = false;
        return;
      }
    } catch (err) {
      console.log(`[runner] reconnect attempt ${attempt} threw: ${(err as Error).message}`);
    }
  }
  console.error(`[runner] reconnect budget exhausted after ${attempt} attempts; exiting`);
  reconnecting = false;
  process.exit(1);
}

const opencode = createOpencodeClient({ baseUrl: OPENCODE_BASE_URL });
let opencodeSessionId: string | null = null;
let sseAbort: AbortController | null = null;
// Track the *opencode* turn currently in flight, so SSE events outside it
// can be ignored (e.g. plugin.added bursts on first boot).
// We accumulate the most recent text/tool part state so we can emit
// transition events without re-sending payloads.
const seenToolCalls = new Set<string>();
// Sum tokens across turns; emitted as artifacts.usage at terminal.
const usageRollup: {
  input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number; cost: number;
} = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

function sendEvent(eventType: string, eventPayload: Record<string, unknown>): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: "runner.event",
    sessionId: SESSION_ID,
    payload: { eventType, eventPayload },
  }));
}

function sendComplete(payload: Record<string, unknown>): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "runner.complete", sessionId: SESSION_ID, payload }));
}

function sendError(error: string): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "runner.error", sessionId: SESSION_ID, payload: { error } }));
}

function execCmd(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    execCb(cmd, { cwd: REPO_DIR }, (_err, stdout) => resolve(stdout || ""));
  });
}

function execStrict(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execCb(cmd, { cwd: REPO_DIR }, (err, stdout, stderr) => {
      if (err) reject(new Error(`exec failed (${cmd}): ${stderr || stdout || err.message}`));
      else resolve((stdout || "") + (stderr ? `\n${stderr}` : ""));
    });
  });
}

async function startSseSubscriber(): Promise<void> {
  if (sseAbort) return;
  sseAbort = new AbortController();
  const mapper = createEventMapper((e) => sendEvent(e.eventType, e.eventPayload));
  const url = `${OPENCODE_BASE_URL}/event?directory=${encodeURIComponent(REPO_DIR)}`;
  console.log("[runner] SSE subscribe:", url);

  // Use raw fetch with streaming body to read SSE frames. The SDK exposes
  // the same endpoint via client.event.subscribe(), but we want explicit
  // abort control + simple parsing without buffering an AsyncGenerator.
  fetch(url, { signal: sseAbort.signal, headers: { accept: "text/event-stream" } })
    .then(async (resp) => {
      if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by blank lines; each frame has
        // `data: <json>` (single line).
        let nl;
        while ((nl = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const obj = JSON.parse(line.slice(5).trim()) as { type: string; properties?: Record<string, unknown> };
              mapper(obj);
            } catch {}
          }
        }
      }
    })
    .catch((err: Error) => {
      if (err.name !== "AbortError") {
        console.error("[runner] SSE error:", err.message);
      }
    });
}

async function ensureOpencodeSession(taskTitle: string): Promise<string> {
  if (opencodeSessionId) return opencodeSessionId;
  const resp = await opencode.session.create({
    body: { title: taskTitle.slice(0, 80) },
    query: { directory: REPO_DIR },
    throwOnError: true,
  });
  opencodeSessionId = resp.data.id;
  console.log("[runner] opencode session created:", opencodeSessionId);
  return opencodeSessionId;
}

interface AssistantMessageInfo {
  id?: string;
  modelID?: string;
  providerID?: string;
  finish?: string;
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  error?: { name?: string; message?: string } | unknown;
}

function rollUsage(info: AssistantMessageInfo | undefined): void {
  if (!info) return;
  const t = info.tokens || {};
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  const reasoning = t.reasoning ?? 0;
  const cacheRead = t.cache?.read ?? 0;
  const cacheWrite = t.cache?.write ?? 0;
  const total = t.total ?? input + output + reasoning;
  const cost = info.cost ?? 0;
  usageRollup.input += input;
  usageRollup.output += output;
  usageRollup.reasoning += reasoning;
  usageRollup.cacheRead += cacheRead;
  usageRollup.cacheWrite += cacheWrite;
  usageRollup.total += total;
  usageRollup.cost += cost;
  sendEvent("agent.usage", {
    modelID: info.modelID,
    providerID: info.providerID,
    tokens: { input, output, reasoning, total, cache: { read: cacheRead, write: cacheWrite } },
    cost,
    cumulative: { ...usageRollup },
  });
}

async function runPromptTurn(taskDescription: string, context: string): Promise<void> {
  await startSseSubscriber();
  const sid = await ensureOpencodeSession(taskDescription);
  // Hermes passes the user's task as `context` (already includes task body
  // per docs/ROADMAP.md §M1). Send it verbatim.
  const text = context || taskDescription;
  sendEvent("agent.started", { taskDescription });

  try {
    const resp = await opencode.session.prompt({
      path: { id: sid },
      query: { directory: REPO_DIR },
      body: {
        model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
        parts: [{ type: "text", text }],
        // §12.17 — pre-declare every tool as allowed so opencode never emits
        // permission.asked. Hermes runs unattended; there is no UI to reply.
        // Overrides default "build" agent's edge-case asks (.env, external_directory)
        // and any user-supplied opencode.json in the cloned repo.
        tools: ALLOW_ALL_TOOLS,
      },
      throwOnError: true,
    });
    const info = resp.data?.info as AssistantMessageInfo | undefined;
    rollUsage(info);

    // Compute diff + changed files (still useful for downstream PR step).
    const diff = await execCmd("git diff");
    const changedFiles = (await execCmd("git diff --name-only")).trim().split("\n").filter(Boolean);

    if (diff) sendEvent("git.diff.ready", { diff });
    sendEvent("agent.done", { summary: "Task completed" });
    sendComplete({
      summary: `Completed: ${taskDescription}`,
      diff,
      changedFiles,
      usage: { ...usageRollup },
    });
    console.log("[runner] Task completed; usage=", JSON.stringify(usageRollup));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendEvent("agent.error", { error: msg });
    sendError(msg);
  }
}

async function runPrCreation(payload: Record<string, unknown>): Promise<void> {
  const branch = (payload.branch as string) || `hermes/${Date.now()}`;
  const title = (payload.title as string) || `Hermes: ${payload.taskDescription ?? "automated change"}`;
  const body = (payload.body as string) || "Automated PR created by hermes-control-plane.";
  const token = process.env.GITHUB_TOKEN || "";
  const owner = process.env.GITHUB_OWNER || "";
  const repo = process.env.GITHUB_REPO || "";
  const baseBranch = process.env.GITHUB_BASE_BRANCH || "main";

  if (!token || !owner || !repo) {
    sendError(`Missing GitHub credentials: token=${!!token} owner=${owner} repo=${repo}`);
    return;
  }

  try {
    await execStrict(`git config user.email "hermes-bot@users.noreply.github.com"`);
    await execStrict(`git config user.name "hermes-bot"`);
    await execStrict(`git checkout -B ${branch}`);
    await execStrict(`git add -A`);
    const diff = await execCmd(`git diff --cached --name-only`);
    if (!diff.trim()) {
      sendError("No changes staged for PR");
      return;
    }
    await execStrict(`git commit -m "${title.replace(/"/g, '\"')}"`);
    const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    await execStrict(`git remote set-url origin ${remoteUrl}`);
    const pushOut = await execStrict(`git push --set-upstream origin ${branch} 2>&1`);
    sendEvent("git.branch.pushed", { branch, pushOutput: pushOut.slice(-500) });

    const prResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, head: branch, base: baseBranch, body }),
    });
    if (!prResp.ok) {
      const errBody = await prResp.text();
      sendError(`GitHub PR API ${prResp.status}: ${errBody.slice(0, 300)}`);
      return;
    }
    const prJson = (await prResp.json()) as { html_url: string; number: number };
    sendEvent("pr.created", { url: prJson.html_url, number: prJson.number, branch });
    sendComplete({ prUrl: prJson.html_url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(`PR creation failed: ${msg}`);
  }
}

function attachHandlers(): void {
  ws.on("open", () => {
    console.log("[runner] Connected to control plane");
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "runner.heartbeat", sessionId: SESSION_ID }));
      }
    }, 10000);
  });

  ws.on("message", async (data: Buffer) => {
    const raw = data.toString();
    let msg: { type: string; command?: { commandId: string; type: string; payload: Record<string, unknown> } };
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type !== "command" || !msg.command) return;
    const cmd = msg.command;
    console.log("[runner] Command:", cmd.type);

    ws.send(JSON.stringify({
      type: "runner.command_ack",
      sessionId: SESSION_ID,
      payload: { commandId: cmd.commandId },
    }));

    if (cmd.type === "agent.prompt") {
      const task = cmd.payload.taskDescription as string;
      const context = (cmd.payload.context as string) || "";
      await runPromptTurn(task, context);
      return;
    }

    if (cmd.type === "pr.create") {
      await runPrCreation(cmd.payload);
      return;
    }

    if (cmd.type === "session.shutdown") {
      shuttingDown = true;
      if (heartbeat) clearInterval(heartbeat);
      if (sseAbort) sseAbort.abort();
      ws.close(1000, "shutdown");
      process.exit(0);
    }
  });

  ws.on("close", (code: number) => {
    console.log("[runner] WS closed:", code);
    if (heartbeat) clearInterval(heartbeat);
    if (shuttingDown) return;
    // M5: outbound WS dies on sandbox pause/resume (verified §12.14
    // probe — close fires with code 1006). Try to reconnect; if budget
    // exhausts, process.exit(1) so the supervisor babysit chain tears
    // down opencode serve.
    void reconnect();
  });

  ws.on("error", (err: Error) => {
    console.error("[runner] WS error:", err.message);
    // close will fire after this; reconnect happens there.
  });
}

attachHandlers();

