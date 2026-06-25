// hermes-launcher — Bun HTTP sidecar.
//
// Holds the only E2B and GitHub-App credentials in the system. Clients
// (web UI, Slack bot, CLI) talk to this; this talks to the Cloudflare
// Worker for session state and to E2B for sandbox lifecycle.
//
// Routes:
//   GET  /health
//   POST /mcp                Model Context Protocol (Streamable HTTP). Hermes
//                            Agent and other MCP hosts call this. Tools:
//                            start_coding_task, get_session_status,
//                            send_followup_prompt, abort_session.
//   POST /sessions           { taskDescription, repoUrl, projectId?, baseBranch? }
//   GET  /sessions/:id        passthrough to Worker
//   DELETE /sessions/:id      kill sandbox + abort DO session
//   POST /sessions/:id/resume  M5: Sandbox.connect() on a paused sandbox
//
// Run:
//   E2B_API_KEY=... ZAI_API_KEY=... GITHUB_APP_ID=... GITHUB_PRIVATE_KEY_FILE=... \
//   HERMES_BASE_URL=http://localhost:8788 HERMES_PUBLIC_URL=https://<ngrok>.ngrok-free.app \
//   bun run src/launcher/server.ts

import { Sandbox } from "e2b";
import { provisionSession, killSandbox, type ProvisionResult } from "./provision";
import { sweepOrphans } from "./sweeper";
import { buildMcpHandler } from "../mcp/server";

const PORT = Number(process.env.HERMES_LAUNCHER_PORT ?? 8789);
const HERMES_BASE_URL = process.env.HERMES_BASE_URL;
const HERMES_PUBLIC_URL = process.env.HERMES_PUBLIC_URL ?? HERMES_BASE_URL;
const E2B_API_KEY = process.env.E2B_API_KEY;
const E2B_TEMPLATE = process.env.E2B_TEMPLATE ?? "hermes-runner";
const ZAI_API_KEY = process.env.ZAI_API_KEY;
const GITHUB_USER_TOKEN = process.env.GITHUB_USER_TOKEN;
const GITHUB_USER_LOGIN = process.env.GITHUB_USER_LOGIN;
const MAX_CONCURRENT_SESSIONS = Number(process.env.MAX_CONCURRENT_SESSIONS ?? 10);
// When false, the sidecar will NOT auto-trigger /create-pr on review_ready.
// Useful for e2e tests that need to send follow-up prompts before the
// runner exits. Default true (production behaviour).
const AUTO_PR = (process.env.HERMES_AUTO_PR ?? "1") !== "0";

const requiredEnv: Array<[string, string | undefined]> = [
  ["E2B_API_KEY", E2B_API_KEY],
  ["ZAI_API_KEY", ZAI_API_KEY],
  ["GITHUB_USER_TOKEN", GITHUB_USER_TOKEN],
  ["GITHUB_USER_LOGIN", GITHUB_USER_LOGIN],
  ["HERMES_BASE_URL", HERMES_BASE_URL],
];
const missing = requiredEnv.filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) {
  console.error(`[launcher] required env missing: ${missing.join(", ")}`);
  process.exit(1);
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

interface ActiveSession {
  sandboxId: string;
  kill: ProvisionResult["kill"];
  startedAt: number;
}
const activeSessions = new Map<string, ActiveSession>();

function log(msg: string): void {
  console.log(`[launcher] ${msg}`);
}

async function countActiveSandboxes(): Promise<number> {
  try {
    const r = await fetch("https://api.e2b.dev/v2/sandboxes", {
      headers: { "X-API-Key": E2B_API_KEY! },
    });
    if (!r.ok) return -1;
    const body = (await r.json()) as unknown;
    if (Array.isArray(body)) return body.length;
    const wrap = body as { sandboxes?: unknown[] };
    return Array.isArray(wrap.sandboxes) ? wrap.sandboxes.length : 0;
  } catch {
    return -1;
  }
}

/** Background poller: drive create-pr on review_ready, kill sandbox on terminal. */
function watchSession(sessionId: string): void {
  const intervalMs = 3000;
  // 24 h: a runaway-job backstop, NOT a follow-up window cap. Paused
  // sandboxes are free + indefinite on E2B (verified §12.14); the only
  // reason to kill is if a session has been forgotten about for a day.
  // Once §12 M5 ships, this will be replaced by D1/R2 retention cron.
  const deadlineAt = Date.now() + 24 * 60 * 60 * 1000;
  let prTriggered = false;

  const tick = async (): Promise<void> => {
    const entry = activeSessions.get(sessionId);
    if (!entry) return; // already cleaned up

    let done = false;
    try {
      const r = await fetch(`${HERMES_BASE_URL}/sessions/${sessionId}`);
      if (r.ok) {
        const data = (await r.json()) as { session?: { status: string } };
        const status = data.session?.status ?? "";
if (status === "review_ready" && !prTriggered && AUTO_PR) {
          prTriggered = true;
          log(`session ${sessionId.slice(0, 8)} review_ready -> trigger create-pr`);
          try {
            await fetch(`${HERMES_BASE_URL}/sessions/${sessionId}/create-pr`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            log(`create-pr POST failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`);
          }
        }
        if (TERMINAL_STATUSES.has(status)) {
          log(`session ${sessionId.slice(0, 8)} terminal=${status}; killing sandbox ${entry.sandboxId}`);
          await entry.kill();
          activeSessions.delete(sessionId);
          done = true;
        }
      } else if (r.status === 404) {
        log(`session ${sessionId.slice(0, 8)} 404; killing sandbox ${entry.sandboxId}`);
        await entry.kill();
        activeSessions.delete(sessionId);
        done = true;
      }
    } catch (err) {
      log(`watch tick err for ${sessionId.slice(0, 8)}: ${(err as Error).message}`);
    }

    if (!done) {
      if (Date.now() > deadlineAt) {
        log(`session ${sessionId.slice(0, 8)} watch deadline; killing sandbox ${entry.sandboxId}`);
        await entry.kill();
        activeSessions.delete(sessionId);
        return;
      }
      setTimeout(tick, intervalMs);
    }
  };
  setTimeout(tick, intervalMs);
}

interface CreateBody {
  taskDescription: string;
  repoUrl: string;
  projectId?: string;
  baseBranch?: string;
}

async function handleCreate(req: Request): Promise<Response> {
  const body = (await req.json()) as CreateBody;
  if (!body.taskDescription || !body.repoUrl) {
    return Response.json({ error: "taskDescription and repoUrl required" }, { status: 400 });
  }

  // M3 concurrency guard (host-side).
  const sbxCount = await countActiveSandboxes();
  if (sbxCount >= 0 && sbxCount >= MAX_CONCURRENT_SESSIONS) {
    return Response.json(
      { error: "Too many concurrent sessions", active: sbxCount, limit: MAX_CONCURRENT_SESSIONS },
      { status: 429 },
    );
  }

  // 1. Create the session DO via the Worker.
  const wResp = await fetch(`${HERMES_BASE_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: body.projectId ?? "default",
      taskDescription: body.taskDescription,
      repoUrl: body.repoUrl,
    }),
  });
  if (!wResp.ok) {
    return Response.json(
      { error: "Worker session create failed", status: wResp.status, body: await wResp.text() },
      { status: 502 },
    );
  }
  const session = (await wResp.json()) as { id: string; runnerToken: string };

  // 2. Provision the sandbox.
  let provisioned: ProvisionResult;
  try {
    provisioned = await provisionSession({
      sessionId: session.id,
      runnerToken: session.runnerToken,
      controlWsUrl: HERMES_PUBLIC_URL!,
      repoUrl: body.repoUrl,
      baseBranch: body.baseBranch,
      e2bApiKey: E2B_API_KEY!,
      e2bTemplate: E2B_TEMPLATE,
      zaiApiKey: ZAI_API_KEY,
      githubAppId: process.env.GITHUB_APP_ID,
      githubPrivateKey: process.env.GITHUB_PRIVATE_KEY,
      githubPrivateKeyFile: process.env.GITHUB_PRIVATE_KEY_FILE,
      githubUserToken: process.env.GITHUB_USER_TOKEN,
      githubUserLogin: process.env.GITHUB_USER_LOGIN,
      githubUserEmail: process.env.GITHUB_USER_EMAIL,
    });
  } catch (err) {
    await fetch(`${HERMES_BASE_URL}/sessions/${session.id}/abort`, { method: "POST" });
    return Response.json(
      { error: "provision failed", sessionId: session.id, detail: (err as Error).message },
      { status: 500 },
    );
  }

  // 3. Track + start the lifecycle watcher.
  activeSessions.set(session.id, {
    sandboxId: provisioned.sandboxId,
    kill: provisioned.kill,
    startedAt: Date.now(),
  });
  watchSession(session.id);

  log(`session ${session.id.slice(0, 8)} provisioned sandbox=${provisioned.sandboxId}`);

  return Response.json(
    {
      sessionId: session.id,
      sandboxId: provisioned.sandboxId,
      streamUrl: `${HERMES_BASE_URL}/sessions/${session.id}/stream`,
      stateUrl: `${HERMES_BASE_URL}/sessions/${session.id}`,
    },
    { status: 201 },
  );
}

async function handleDelete(sessionId: string): Promise<Response> {
  const entry = activeSessions.get(sessionId);
  if (entry) {
    await entry.kill();
    activeSessions.delete(sessionId);
  } else {
    // Sidecar restarted and forgot. Kill any sandbox tagged with this session.
    try {
      const r = await fetch("https://api.e2b.dev/v2/sandboxes", {
        headers: { "X-API-Key": E2B_API_KEY! },
      });
      if (r.ok) {
        const list = (await r.json()) as { sandboxID?: string; metadata?: Record<string, string> }[];
        for (const sbx of list) {
          if (sbx.metadata?.hermes_session_id === sessionId && sbx.sandboxID) {
            log(`DELETE ${sessionId.slice(0, 8)}: killing untracked sandbox ${sbx.sandboxID}`);
            await killSandbox(E2B_API_KEY!, sbx.sandboxID);
          }
        }
      }
    } catch {
      // ignore
    }
  }
  await fetch(`${HERMES_BASE_URL}/sessions/${sessionId}/abort`, { method: "POST" });
  return Response.json({ ok: true });
}

/** Find the (active or paused) E2B sandbox tagged with this session id.
 *  Returns the sandbox id, or null if no sandbox exists for the session
 *  any more (E2B never auto-kills, so this only happens after an explicit
 *  kill). M5: launcher /resume uses this to locate the sandbox without
 *  relying on activeSessions, so resume works across launcher restarts. */
async function findSandboxForSession(sessionId: string): Promise<string | null> {
  // Prefer in-memory tracking when available (fast path, no E2B round-trip).
  const tracked = activeSessions.get(sessionId);
  if (tracked) return tracked.sandboxId;
  try {
    const paginator = Sandbox.list({
      apiKey: E2B_API_KEY!,
      query: { state: ["running", "paused"] },
    });
    while (paginator.hasNext) {
      const items = await paginator.nextItems();
      for (const sbx of items) {
        const meta = (sbx as unknown as { metadata?: Record<string, string> }).metadata ?? {};
        if (meta.hermes_session_id === sessionId && sbx.sandboxId) {
          return sbx.sandboxId;
        }
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/** POST /sessions/:id/resume — M5: thaw the paused sandbox so the runner
 *  reconnects to the DO and a queued follow-up prompt can be delivered. */
async function handleResume(sessionId: string): Promise<Response> {
  const sandboxId = await findSandboxForSession(sessionId);
  if (!sandboxId) {
    return Response.json(
      {
        error: "Sandbox not found",
        reason: "No live or paused sandbox is tagged with this session id. The session may have been explicitly killed or its sandbox sweeped. Start a new session.",
        recoverable: false,
      },
      { status: 410 },
    );
  }
  const t0 = Date.now();
  try {
    await Sandbox.connect(sandboxId, { apiKey: E2B_API_KEY! });
    log(`session ${sessionId.slice(0, 8)} resumed sandbox=${sandboxId} (${Date.now() - t0}ms)`);
    return Response.json({ ok: true, sandboxId, resumedInMs: Date.now() - t0 });
  } catch (err) {
    const msg = (err as Error).message;
    // E2B returns 404 when the sandbox has been killed despite paused-is-
    // forever guarantee. Treat as terminal.
    if (msg.includes("404")) {
      return Response.json(
        {
          error: "Sandbox no longer exists",
          reason: "The sandbox was killed (likely by an explicit DELETE). Start a new session.",
          recoverable: false,
        },
        { status: 410 },
      );
    }
    log(`session ${sessionId.slice(0, 8)} resume failed: ${msg}`);
    return Response.json(
      { error: "Resume failed", reason: msg, recoverable: true },
      { status: 502 },
    );
  }
}


async function handleGet(sessionId: string): Promise<Response> {
  const r = await fetch(`${HERMES_BASE_URL}/sessions/${sessionId}`);
  return new Response(await r.text(), {
    status: r.status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleHealth(): Promise<Response> {
  return Response.json({
    status: "ok",
    activeSessions: activeSessions.size,
    sessions: [...activeSessions.entries()].map(([id, s]) => ({
      sessionId: id,
      sandboxId: s.sandboxId,
      startedAt: s.startedAt,
    })),
    worker: HERMES_BASE_URL,
    publicUrl: HERMES_PUBLIC_URL,
    cap: MAX_CONCURRENT_SESSIONS,
  });
}

async function main(): Promise<void> {
  // Startup sweep.
  try {
    const sweep = await sweepOrphans({
      e2bApiKey: E2B_API_KEY!,
      hermesBaseUrl: HERMES_BASE_URL!,
    });
    log(
      `startup sweep: scanned=${sweep.scanned} killed=${sweep.killed.length} kept=${sweep.kept.length}`,
    );
    if (sweep.killed.length) log(`  killed: ${sweep.killed.join(", ")}`);
  } catch (err) {
    log(`startup sweep failed: ${(err as Error).message}`);
  }

  // MCP server bundled into the launcher (the Hermes Agent — see
  // docs/DEPLOYMENT.md §12 and infra/mcp/README.md.
  const mcpHandler = buildMcpHandler({
    workerBaseUrl: HERMES_BASE_URL!,
    launcherBaseUrl: `http://localhost:${PORT}`,
    log,
  });

  // @ts-expect-error Bun-only global
  const server = Bun.serve({
    port: PORT,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/health") return await handleHealth();
        if (url.pathname === "/mcp") {
          return await mcpHandler(req);
        }
        if (url.pathname === "/sessions" && req.method === "POST") {
          return await handleCreate(req);
        }
        const m = url.pathname.match(/^\/sessions\/([^/]+)$/);
        if (m) {
          const id = m[1];
          if (req.method === "DELETE") return await handleDelete(id);
          if (req.method === "GET") return await handleGet(id);
        }
        const rm = url.pathname.match(/^\/sessions\/([^/]+)\/resume$/);
        if (rm && req.method === "POST") return await handleResume(rm[1]);
        return Response.json({ error: "not found" }, { status: 404 });
      } catch (err) {
        log(`fetch error: ${(err as Error).message}`);
        return Response.json({ error: (err as Error).message }, { status: 500 });
      }
    },
  });

  log(`hermes-launcher listening on http://localhost:${server.port}`);
  log(`  worker = ${HERMES_BASE_URL}`);
  log(`  public = ${HERMES_PUBLIC_URL}`);
  log(`  cap    = ${MAX_CONCURRENT_SESSIONS}`);
  log(`  autoPR = ${AUTO_PR}`);
  log(`  mcp    = http://localhost:${server.port}/mcp`);
}

main().catch((err) => {
  console.error("[launcher] fatal:", err);
  process.exit(1);
});
