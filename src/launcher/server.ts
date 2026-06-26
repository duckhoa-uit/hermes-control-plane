// control-plane-launcher — Bun HTTP sidecar.
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
//   E2B_API_KEY=... ZAI_API_KEY=... GITHUB_USER_TOKEN=... GITHUB_USER_LOGIN=... \
//   CONTROL_PLANE_BASE_URL=https://<deployed-worker>.workers.dev \
//   bun run src/launcher/server.ts

import { Sandbox } from "e2b";
import { provisionSession, killSandbox, type ProvisionResult } from "./provision";
import { sweepOrphans } from "./sweeper";
import { buildMcpHandler } from "../mcp/server";

const PORT = Number(process.env.CONTROL_PLANE_LAUNCHER_PORT ?? 8789);
const CONTROL_PLANE_BASE_URL = process.env.CONTROL_PLANE_BASE_URL;
const E2B_API_KEY = process.env.E2B_API_KEY;
const E2B_TEMPLATE = process.env.E2B_TEMPLATE ?? "control-plane-runner";
const ZAI_API_KEY = process.env.ZAI_API_KEY;
const GITHUB_USER_TOKEN = process.env.GITHUB_USER_TOKEN;
const GITHUB_USER_LOGIN = process.env.GITHUB_USER_LOGIN;
const MAX_CONCURRENT_SESSIONS = Number(process.env.MAX_CONCURRENT_SESSIONS ?? 10);
// When false, the sidecar will NOT auto-trigger /create-pr on review_ready.
// Useful for e2e tests that need to send follow-up prompts before the
// runner exits. Default true (production behaviour).
const AUTO_PR = (process.env.CONTROL_PLANE_AUTO_PR ?? "1") !== "0";

const requiredEnv: Array<[string, string | undefined]> = [
  ["E2B_API_KEY", E2B_API_KEY],
  ["ZAI_API_KEY", ZAI_API_KEY],
  ["GITHUB_USER_TOKEN", GITHUB_USER_TOKEN],
  ["GITHUB_USER_LOGIN", GITHUB_USER_LOGIN],
  ["CONTROL_PLANE_BASE_URL", CONTROL_PLANE_BASE_URL],
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
      const r = await fetch(`${CONTROL_PLANE_BASE_URL}/sessions/${sessionId}`);
      if (r.ok) {
        const data = (await r.json()) as { session?: { status: string } };
        const status = data.session?.status ?? "";
if (status === "review_ready" && !prTriggered && AUTO_PR) {
          prTriggered = true;
          log(`session ${sessionId.slice(0, 8)} review_ready -> trigger create-pr`);
          try {
            await fetch(`${CONTROL_PLANE_BASE_URL}/sessions/${sessionId}/create-pr`, {
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
  repoUrl?: string;
  projectId?: string;
  baseBranch?: string;
  // Follow-up amend: when set, the launcher resolves repoUrl/baseBranch
  // and the prMode triple from the parent session's state + the global
  // PR index. The caller only needs to supply taskDescription.
  parentSessionId?: string;
}

interface PrIndexRowWire {
  prKey: string;
  sessionId: string;
  ownerLogin: string;
  status: "open" | "merged" | "closed";
  autofixCount: number;
}

async function resolveParentAmend(
  parentSessionId: string,
): Promise<{
  ok: true;
  repoUrl: string;
  baseBranch: string;
  prMode: { branch: string; prNumber: number; prUrl: string };
} | { ok: false; status: number; error: string; reason: string }> {
  // 1. Parent session state — needs repoUrl, baseBranch, branch, prUrl.
  const sResp = await fetch(`${CONTROL_PLANE_BASE_URL}/sessions/${parentSessionId}`);
  if (sResp.status === 404) {
    return { ok: false, status: 404, error: "parent session not found", reason: "parentSessionId does not exist" };
  }
  if (!sResp.ok) {
    return { ok: false, status: 502, error: "worker getState failed", reason: `${sResp.status}` };
  }
  const data = (await sResp.json()) as {
    session: { id: string; branch: string; status: string } | null;
    artifacts: { prUrl?: string } | null;
    repoUrl: string | null;
    baseBranch: string | null;
  };
  if (!data.session || !data.repoUrl) {
    return { ok: false, status: 410, error: "parent session has no repo", reason: "session state is incomplete" };
  }
  const prUrl = data.artifacts?.prUrl;
  if (!prUrl) {
    return { ok: false, status: 409, error: "parent has no PR yet", reason: "the parent session never reached pr.created — amend mode requires an existing PR" };
  }
  // 2. Parse the PR URL into (owner, repo, number) and look up in the index.
  const m = prUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) {
    return { ok: false, status: 500, error: "cannot parse parent PR URL", reason: prUrl };
  }
  const owner = m[1], repo = m[2], number = Number(m[3]);
  const prKey = `${owner}/${repo}#${number}`;
  const idxResp = await fetch(`${CONTROL_PLANE_BASE_URL}/pr-index?key=${encodeURIComponent(prKey)}`);
  if (idxResp.status === 404) {
    return { ok: false, status: 410, error: "PR no longer indexed", reason: "the PR was unregistered (merged or unknown) — start a fresh session instead of amending" };
  }
  if (!idxResp.ok) {
    return { ok: false, status: 502, error: "PR index lookup failed", reason: `${idxResp.status}` };
  }
  const idx = (await idxResp.json()) as { row: PrIndexRowWire };
  if (idx.row.status !== "open") {
    return { ok: false, status: 410, error: `PR is ${idx.row.status}`, reason: "amend mode requires the PR to still be open" };
  }
  // The parent's session.branch is NOT reliable as the PR head ref:
  // when the parent is itself an amend session, its branch field was set
  // from the spawned session id (hermes/<short of spawn id>), not the
  // original PR branch. Source-of-truth is GitHub itself.
  let headBranch = data.session.branch;
  if (GITHUB_USER_TOKEN) {
    try {
      const ghResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
        headers: {
          Authorization: `Bearer ${GITHUB_USER_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (ghResp.ok) {
        const pr = (await ghResp.json()) as { head?: { ref?: string } };
        if (pr.head?.ref) headBranch = pr.head.ref;
      } else {
        log(`resolveParentAmend: GitHub /pulls/${number} ${ghResp.status} — falling back to session.branch=${data.session.branch}`);
      }
    } catch (err) {
      log(`resolveParentAmend: GitHub /pulls/${number} error: ${(err as Error).message} — falling back to session.branch`);
    }
  }
  return {
    ok: true,
    repoUrl: data.repoUrl,
    baseBranch: data.baseBranch ?? "main",
    prMode: { branch: headBranch, prNumber: number, prUrl },
  };
}

async function handleCreate(req: Request): Promise<Response> {
  const body = (await req.json()) as CreateBody;
  let repoUrl = body.repoUrl;
  let baseBranch = body.baseBranch;
  let prMode: { branch: string; prNumber: number; prUrl: string } | undefined;

  if (body.parentSessionId) {
    const resolved = await resolveParentAmend(body.parentSessionId);
    if (!resolved.ok) {
      return Response.json(
        { error: resolved.error, reason: resolved.reason, parentSessionId: body.parentSessionId },
        { status: resolved.status },
      );
    }
    repoUrl = resolved.repoUrl;
    baseBranch = resolved.baseBranch;
    prMode = resolved.prMode;
  }

  if (!body.taskDescription || !repoUrl) {
    return Response.json(
      { error: "taskDescription and (repoUrl or parentSessionId resolving to a repoUrl) required" },
      { status: 400 },
    );
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
  const wResp = await fetch(`${CONTROL_PLANE_BASE_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: body.projectId ?? "default",
      taskDescription: body.taskDescription,
      repoUrl,
      // Tell the DO this is an amend session so its slot-release hook
      // works even on early abort (before pr.updated is emitted).
      amendPrUrl: prMode?.prUrl,
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
      controlWsUrl: CONTROL_PLANE_BASE_URL!,
      repoUrl,
      baseBranch,
      e2bApiKey: E2B_API_KEY!,
      e2bTemplate: E2B_TEMPLATE,
      zaiApiKey: ZAI_API_KEY,
      githubUserToken: process.env.GITHUB_USER_TOKEN,
      githubUserLogin: process.env.GITHUB_USER_LOGIN,
      githubUserEmail: process.env.GITHUB_USER_EMAIL,
      prMode,
    });
  } catch (err) {
    await fetch(`${CONTROL_PLANE_BASE_URL}/sessions/${session.id}/abort`, { method: "POST" });
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

  log(
    `session ${session.id.slice(0, 8)} provisioned sandbox=${provisioned.sandboxId}` +
    (prMode ? ` amend=${prMode.branch}#${prMode.prNumber}` : ""),
  );

  return Response.json(
    {
      sessionId: session.id,
      sandboxId: provisioned.sandboxId,
      streamUrl: `${CONTROL_PLANE_BASE_URL}/sessions/${session.id}/stream`,
      stateUrl: `${CONTROL_PLANE_BASE_URL}/sessions/${session.id}`,
      // Reflect amend wiring back to the caller (MCP tool surfaces this in
      // structuredContent so the agent can mention the branch in chat).
      parentSessionId: body.parentSessionId,
      prMode: prMode ?? null,
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
  await fetch(`${CONTROL_PLANE_BASE_URL}/sessions/${sessionId}/abort`, { method: "POST" });
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
  const r = await fetch(`${CONTROL_PLANE_BASE_URL}/sessions/${sessionId}`);
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
    worker: CONTROL_PLANE_BASE_URL,
    cap: MAX_CONCURRENT_SESSIONS,
  });
}

async function main(): Promise<void> {
  // Startup sweep.
  try {
    const sweep = await sweepOrphans({
      e2bApiKey: E2B_API_KEY!,
      hermesBaseUrl: CONTROL_PLANE_BASE_URL!,
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
    workerBaseUrl: CONTROL_PLANE_BASE_URL!,
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

  log(`control-plane-launcher listening on http://localhost:${server.port}`);
  log(`  worker = ${CONTROL_PLANE_BASE_URL}`);
  log(`  cap    = ${MAX_CONCURRENT_SESSIONS}`);
  log(`  autoPR = ${AUTO_PR}`);
  log(`  mcp    = http://localhost:${server.port}/mcp`);
}

main().catch((err) => {
  console.error("[launcher] fatal:", err);
  process.exit(1);
});
