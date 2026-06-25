// hermes-launcher — Bun HTTP sidecar.
//
// Holds the only E2B and GitHub-App credentials in the system. Clients
// (web UI, Slack bot, CLI) talk to this; this talks to the Cloudflare
// Worker for session state and to E2B for sandbox lifecycle.
//
// Routes:
//   GET  /health
//   POST /sessions           { taskDescription, repoUrl, projectId?, baseBranch? }
//   GET  /sessions/:id        passthrough to Worker
//   DELETE /sessions/:id      kill sandbox + abort DO session
//
// Run:
//   E2B_API_KEY=... ZAI_API_KEY=... GITHUB_APP_ID=... GITHUB_PRIVATE_KEY_FILE=... \
//   HERMES_BASE_URL=http://localhost:8788 HERMES_PUBLIC_URL=https://<ngrok>.ngrok-free.app \
//   bun run src/launcher/server.ts

import { Sandbox } from "e2b";
import { provisionSession, killSandbox, type ProvisionResult } from "./provision";
import { sweepOrphans } from "./sweeper";

const PORT = Number(process.env.HERMES_LAUNCHER_PORT ?? 8789);
const HERMES_BASE_URL = process.env.HERMES_BASE_URL ?? "http://localhost:8788";
const HERMES_PUBLIC_URL = process.env.HERMES_PUBLIC_URL ?? HERMES_BASE_URL;
const E2B_API_KEY = process.env.E2B_API_KEY;
const E2B_TEMPLATE = process.env.E2B_TEMPLATE ?? "hermes-runner";
const ZAI_API_KEY = process.env.ZAI_API_KEY ?? "";
const MAX_CONCURRENT_SESSIONS = Number(process.env.MAX_CONCURRENT_SESSIONS ?? 10);
// When false, the sidecar will NOT auto-trigger /create-pr on review_ready.
// Useful for e2e tests that need to send follow-up prompts before the
// runner exits. Default true (production behaviour).
const AUTO_PR = (process.env.HERMES_AUTO_PR ?? "1") !== "0";

if (!E2B_API_KEY) {
  console.error("[launcher] E2B_API_KEY required");
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
  // 60 min: matches E2B Hobby's hard 1h per-sandbox cap. Anything
  // running longer than this is past E2B's own limit anyway, so we kill
  // it ourselves to be sure no orphan compute lingers.
  const deadlineAt = Date.now() + 60 * 60 * 1000;
  let prTriggered = false;
  let timeoutExtended = false;

  const tick = async (): Promise<void> => {
    const entry = activeSessions.get(sessionId);
    if (!entry) return; // already cleaned up

    let done = false;
    try {
      const r = await fetch(`${HERMES_BASE_URL}/sessions/${sessionId}`);
      if (r.ok) {
        const data = (await r.json()) as { session?: { status: string } };
        const status = data.session?.status ?? "";
        if (status === "review_ready" && !timeoutExtended) {
          timeoutExtended = true;
          // Extend the E2B sandbox lifetime so a follow-up prompt has a
          // useful window. E2B's default onTimeout (set in provision.ts =
          // 15 min) would otherwise pause the sandbox while idle in
          // review_ready, breaking follow-up POST /prompt. 55 min keeps us
          // safely under E2B Hobby's hard 60-min per-sandbox cap.
          try {
            await Sandbox.setTimeout(entry.sandboxId, 55 * 60 * 1000, { apiKey: E2B_API_KEY! });
            log(`session ${sessionId.slice(0, 8)} review_ready -> extended sandbox timeout to 55 min`);
          } catch (err) {
            log(`setTimeout failed for ${sessionId.slice(0, 8)}: ${(err as Error).message}`);
          }
        }
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
      controlWsUrl: HERMES_PUBLIC_URL,
      repoUrl: body.repoUrl,
      baseBranch: body.baseBranch,
      e2bApiKey: E2B_API_KEY!,
      e2bTemplate: E2B_TEMPLATE,
      zaiApiKey: ZAI_API_KEY,
      githubAppId: process.env.GITHUB_APP_ID,
      githubPrivateKey: process.env.GITHUB_PRIVATE_KEY,
      githubPrivateKeyFile: process.env.GITHUB_PRIVATE_KEY_FILE,
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
      hermesBaseUrl: HERMES_BASE_URL,
    });
    log(
      `startup sweep: scanned=${sweep.scanned} killed=${sweep.killed.length} kept=${sweep.kept.length}`,
    );
    if (sweep.killed.length) log(`  killed: ${sweep.killed.join(", ")}`);
  } catch (err) {
    log(`startup sweep failed: ${(err as Error).message}`);
  }

  // @ts-expect-error Bun-only global
  const server = Bun.serve({
    port: PORT,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/health") return await handleHealth();
        if (url.pathname === "/sessions" && req.method === "POST") {
          return await handleCreate(req);
        }
        const m = url.pathname.match(/^\/sessions\/([^/]+)$/);
        if (m) {
          const id = m[1];
          if (req.method === "DELETE") return await handleDelete(id);
          if (req.method === "GET") return await handleGet(id);
        }
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
}

main().catch((err) => {
  console.error("[launcher] fatal:", err);
  process.exit(1);
});
