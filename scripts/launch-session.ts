// hermes session CLI.
//
// Modes:
//   * "sidecar" — call the control-plane-launcher HTTP API. Used when
//     CONTROL_PLANE_LAUNCHER_URL is set. This is the long-term mode.
//   * "direct"  — provision the sandbox in-process. Kept as a fallback for
//     when the launcher isn't running.
//
// In both modes the script polls the Worker for events until the session is
// terminal and (in direct mode only) tears the sandbox down at the end.

import { provisionSession, killSandbox } from "../src/launcher/provision";

const CONTROL_PLANE_BASE_URL = process.env.CONTROL_PLANE_BASE_URL ?? "http://localhost:8788";
const CONTROL_PLANE_LAUNCHER_URL = process.env.CONTROL_PLANE_LAUNCHER_URL;
const E2B_API_KEY = process.env.E2B_API_KEY;
const E2B_TEMPLATE = process.env.E2B_TEMPLATE ?? "control-plane-runner";
const ZAI_API_KEY = process.env.ZAI_API_KEY ?? "";
const ZAI_MODEL_RAW = process.env.ZAI_MODEL ?? "glm-5.2";
const ZAI_MODEL = ZAI_MODEL_RAW.includes("/") ? ZAI_MODEL_RAW : `zai-coding-plan/${ZAI_MODEL_RAW}`;
const MAX_CONCURRENT_SESSIONS = Number(process.env.MAX_CONCURRENT_SESSIONS ?? 10);

const repoUrl = process.argv[2];
const task = process.argv[3];
const projectId = process.argv[4] ?? "default";

if (!repoUrl || !task) {
  console.error('Usage: bun run scripts/launch-session.ts <repoUrl> "<task>" [projectId]');
  process.exit(1);
}

function log(s: string): void {
  console.log(`[launch] ${s}`);
}

const TERMINAL = new Set(["completed", "failed", "aborted"]);

async function pollStatus(sessionId: string): Promise<void> {
  let lastSeq = -1;
  let prTriggered = false;
  const t0 = Date.now();
  const deadline = t0 + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const r = await fetch(`${CONTROL_PLANE_BASE_URL}/sessions/${sessionId}`);
    if (!r.ok) {
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    const data = (await r.json()) as {
      session: { status: string };
      events: { seq: number; type: string; source: string; payload: Record<string, unknown> }[];
    };
    for (const ev of data.events) {
      if (ev.seq > lastSeq) {
        lastSeq = ev.seq;
        log(`[seq ${ev.seq}] ${ev.type} (${ev.source})  ${JSON.stringify(ev.payload).slice(0, 200)}`);
      }
    }
    if (data.session.status === "review_ready" && !prTriggered) {
      prTriggered = true;
      log(`session review_ready -> triggering create-pr`);
      const prResp = await fetch(`${CONTROL_PLANE_BASE_URL}/sessions/${sessionId}/create-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      log(`create-pr response: ${prResp.status} ${await prResp.text()}`);
    }
    if (TERMINAL.has(data.session.status)) {
      log(`session terminal: ${data.session.status} after ${Date.now() - t0}ms`);
      return;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  log("polling deadline exceeded");
}

async function runSidecarMode(): Promise<void> {
  log(`mode=sidecar url=${CONTROL_PLANE_LAUNCHER_URL}`);
  const r = await fetch(`${CONTROL_PLANE_LAUNCHER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskDescription: task, repoUrl, projectId }),
  });
  if (!r.ok) {
    console.error(`launcher ${r.status}:`, await r.text());
    process.exit(1);
  }
  const data = (await r.json()) as { sessionId: string; sandboxId: string };
  log(`session=${data.sessionId} sandbox=${data.sandboxId}`);
  await pollStatus(data.sessionId);
  // Sidecar cleans up the sandbox; nothing else for the CLI to do.
}

async function checkConcurrencyCap(): Promise<void> {
  try {
    const r = await fetch("https://api.e2b.dev/v2/sandboxes", {
      headers: { "X-API-Key": E2B_API_KEY! },
    });
    if (!r.ok) return;
    const body = (await r.json()) as unknown;
    const count = Array.isArray(body)
      ? body.length
      : Array.isArray((body as { sandboxes?: unknown[] }).sandboxes)
        ? (body as { sandboxes: unknown[] }).sandboxes.length
        : 0;
    log(`[m3] active sandboxes=${count} cap=${MAX_CONCURRENT_SESSIONS}`);
    if (count >= MAX_CONCURRENT_SESSIONS) {
      console.error(`[m3] refusing to launch: ${count} active, cap ${MAX_CONCURRENT_SESSIONS}`);
      process.exit(2);
    }
  } catch {
    // proceed
  }
}

async function runDirectMode(): Promise<void> {
  if (!E2B_API_KEY) {
    console.error("E2B_API_KEY required in direct mode");
    process.exit(1);
  }
  log(`mode=direct`);
  await checkConcurrencyCap();

  const createResp = await fetch(`${CONTROL_PLANE_BASE_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, taskDescription: task, repoUrl }),
  });
  if (!createResp.ok) {
    console.error("session create failed:", createResp.status, await createResp.text());
    process.exit(1);
  }
  const session = (await createResp.json()) as { id: string; runnerToken: string };
  log(`session id = ${session.id}`);

  let provisioned;
  try {
    provisioned = await provisionSession({
      sessionId: session.id,
      runnerToken: session.runnerToken,
      controlWsUrl: CONTROL_PLANE_BASE_URL,
      repoUrl,
      e2bApiKey: E2B_API_KEY,
      e2bTemplate: E2B_TEMPLATE,
      zaiApiKey: ZAI_API_KEY,
      opencodeModel: ZAI_MODEL,
      githubUserToken: process.env.GITHUB_USER_TOKEN,
      githubUserLogin: process.env.GITHUB_USER_LOGIN,
      githubUserEmail: process.env.GITHUB_USER_EMAIL,
    });
    log(`sandbox=${provisioned.sandboxId} created`);
  } catch (err) {
    await fetch(`${CONTROL_PLANE_BASE_URL}/sessions/${session.id}/abort`, { method: "POST" });
    log(`provision failed: ${(err as Error).message}; aborted`);
    process.exit(1);
  }

  try {
    await pollStatus(session.id);
  } finally {
    log(`killing sandbox ${provisioned.sandboxId}`);
    await provisioned.kill();
  }
}

if (CONTROL_PLANE_LAUNCHER_URL) {
  runSidecarMode().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runDirectMode().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// killSandbox imported solely to keep API surface stable for callers that
// might want to use it; not invoked here.
void killSandbox;
