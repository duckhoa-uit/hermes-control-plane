// ============================================================
// Full-system E2E — drives real E2B sandbox + real OpenCode agent +
// real GitHub PR creation, end-to-end through the launcher.
//
// REQUIRES:
//   - Terminal 1: `bunx wrangler dev` (worker on :8787)
//   - Terminal 2: ngrok tunnel to :8787 (e.g. `ngrok http 8787`)
//   - Terminal 3: `bun run launcher` with these env vars:
//       WORKER_URL=<https ngrok URL>
//       E2B_API_KEY, ZAI_API_KEY, GITHUB_WRITE_TOKEN, GITHUB_USER_LOGIN
//   - Terminal 4: THIS script:
//       bun run scripts/e2e-full.ts \
//         --repo https://github.com/<you>/<throwaway>     \
//         --task "Add a file E2E_TEST.md with the text 'hello from hermes e2e'" \
//         [--base-branch main] [--launcher http://localhost:8789]
//
// COSTS (per run):
//   - 1 E2B sandbox spin (~few minutes Hobby tier)
//   - 1 LLM session via Zai (small token usage for trivial tasks)
//   - 1 PR + 1 branch in the target repo (script will print URLs)
//
// Exits 0 only if a real GitHub PR URL is produced AND fetched by HTTP.
// ============================================================

import { WebSocket } from "ws";
import { parseArgs } from "node:util";

const args = parseArgs({
  options: {
    repo: { type: "string" },
    task: { type: "string" },
    "base-branch": { type: "string", default: "main" },
    launcher: { type: "string", default: "http://localhost:8789" },
    "no-stream": { type: "boolean", default: false }, // don't subscribe client WS
    "keep-sandbox": { type: "boolean", default: false }, // skip DELETE at the end
    timeout: { type: "string", default: "600" }, // seconds
  },
  allowPositionals: false,
});

const REPO = args.values.repo;
const TASK =
  args.values.task ??
  "Create a new file at the repo root named E2E_TEST.md containing exactly the line: 'hello from hermes e2e'. Commit the file. Do not change any other file.";
const BASE_BRANCH = args.values["base-branch"]!;
const LAUNCHER = args.values.launcher!;
const TIMEOUT_MS = Number(args.values.timeout) * 1000;

if (!REPO) {
  console.error(
    "Usage: bun run scripts/e2e-full.ts --repo <github-https-url> [--task '...'] [--base-branch main]",
  );
  process.exit(2);
}
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(REPO)) {
  console.error(`--repo must look like https://github.com/<owner>/<name>; got: ${REPO}`);
  process.exit(2);
}

// ---- Output helpers ----

let stepCount = 0;
let failures = 0;
function section(t: string) {
  console.log(`\n\x1b[1m▸ ${t}\x1b[0m`);
}
function ok(msg: string) {
  stepCount++;
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}
function bad(msg: string) {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}
function info(msg: string) {
  console.log(`    \x1b[2m${msg}\x1b[0m`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (cond) ok(msg);
  else {
    bad(msg);
    throw new Error(`step failed: ${msg}`);
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- HTTP ----

const LAUNCHER_SECRET = process.env.LAUNCHER_SHARED_SECRET || "";

async function http<T = any>(
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T; raw: string }> {
  // Launcher REST routes are gated by LAUNCHER_SHARED_SECRET; always
  // send the header so this script works against launchers that enforce
  // auth and noops against ones that don't.
  const isLauncher = url.startsWith(LAUNCHER);
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (isLauncher && LAUNCHER_SECRET) headers["x-hermes-launcher-secret"] = LAUNCHER_SECRET;
  // fetch rejects `body` (even when undefined) on GET — only attach for
  // methods that allow a payload.
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  const raw = await resp.text();
  let parsed: any = raw;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {}
  return { status: resp.status, body: parsed, raw };
}

async function getState(launcherOrWorker: string, sessionId: string) {
  // Launcher proxies GET to Worker. Either base URL works.
  const r = await http("GET", `${launcherOrWorker}/sessions/${sessionId}`);
  return r;
}

// ---- Event streamer (real client WS to Worker) ----
// Used for live logging — does not feed the runner.

function streamEvents(
  workerBaseUrl: string,
  sessionId: string,
): { close: () => void; saw: Set<string> } {
  const wsUrl = workerBaseUrl.replace(/^http/, "ws") + `/sessions/${sessionId}/stream`;
  const ws = new WebSocket(wsUrl);
  const saw = new Set<string>();
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "replay") {
        for (const ev of msg.events) {
          saw.add(ev.type);
          info(`(replay) [${ev.seq}] ${ev.type} ${JSON.stringify(ev.payload).slice(0, 120)}`);
        }
      } else if (msg.type === "event") {
        const ev = msg.event;
        saw.add(ev.type);
        info(`[${ev.seq}] ${ev.type} ${JSON.stringify(ev.payload).slice(0, 120)}`);
      } else if (msg.type === "session_state") {
        info(`[state] ${msg.session.status} branch=${msg.session.branch}`);
      }
    } catch {}
  });
  ws.on("error", (e) => info(`(stream error) ${e.message}`));
  return { close: () => ws.close(), saw };
}

// ---- Main ----

async function main() {
  console.log(`\x1b[1mHermes Full-System E2E\x1b[0m`);
  console.log(`Repo:    ${REPO}`);
  console.log(`Task:    ${TASK}`);
  console.log(`Launcher: ${LAUNCHER}`);
  console.log(`Timeout: ${TIMEOUT_MS / 1000}s\n`);

  // Preflight: launcher up?
  section("Preflight");
  try {
    const h = await http<{ status: string }>("GET", `${LAUNCHER}/health`);
    assert(h.status === 200, `launcher /health → 200 (got ${h.status})`);
  } catch (e) {
    bad(`cannot reach launcher at ${LAUNCHER}: ${(e as Error).message}`);
    console.error(`\n→ Did you start the launcher?  bun run launcher\n`);
    process.exit(2);
  }

  // 1. Create session via LAUNCHER (real flow: launcher spins E2B sandbox)
  section("POST /sessions on launcher → real E2B sandbox provisioning");
  const create = await http<any>("POST", `${LAUNCHER}/sessions`, {
    taskDescription: TASK,
    repoUrl: REPO,
    baseBranch: BASE_BRANCH,
  });
  if (create.status !== 201) {
    bad(`launcher create failed: ${create.status} ${create.raw}`);
    process.exit(1);
  }
  ok(`launcher POST /sessions → 201`);
  const sessionId: string = create.body.sessionId;
  const sandboxId: string = create.body.sandboxId;
  const streamUrl: string = create.body.streamUrl;
  info(`sessionId: ${sessionId}`);
  info(`sandboxId: ${sandboxId}`);
  info(`streamUrl: ${streamUrl}`);

  // Derive worker base URL from streamUrl
  const workerBase = new URL(streamUrl).origin;

  // 2. Subscribe to event stream (real WS to Worker)
  let stream: ReturnType<typeof streamEvents> | null = null;
  if (!args.values["no-stream"]) {
    section("Subscribe to event stream (real WS)");
    stream = streamEvents(workerBase, sessionId);
    info(`subscribed; live agent/tool events will print below`);
  }

  // 3. Poll for terminal state (completed | failed | aborted)
  section("Poll state until terminal");
  const start = Date.now();
  let last: any = null;
  let finalState: string | null = null;
  while (Date.now() - start < TIMEOUT_MS) {
    const s = await getState(workerBase, sessionId);
    if (s.status === 200) {
      last = s.body;
      const status = last.session?.status;
      if (status && ["completed", "failed", "aborted"].includes(status)) {
        finalState = status;
        break;
      }
    }
    await sleep(2500);
  }

  await sleep(500); // let any final event stream in
  stream?.close();

  if (!finalState) {
    bad(
      `timeout after ${TIMEOUT_MS / 1000}s — last status was ${last?.session?.status ?? "<unknown>"}`,
    );
    info(`(sandbox left running — pass --keep-sandbox to skip the next cleanup)`);
    if (!args.values["keep-sandbox"]) {
      await http("DELETE", `${LAUNCHER}/sessions/${sessionId}`);
      info(`launcher DELETE issued`);
    }
    process.exit(1);
  }

  // 4. Verify final state and artifacts
  section("Verify final state");
  assert(finalState === "completed", `session.status === completed (got ${finalState})`);

  const artifacts = last.artifacts;
  assert(artifacts != null, "artifacts payload present");
  const prUrl: string | undefined = artifacts.prUrl;
  assert(
    typeof prUrl === "string" && /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(prUrl),
    `prUrl is a real GitHub PR URL (got ${prUrl})`,
  );

  // 5. HEAD the PR URL — confirm GitHub really has the PR
  section("Verify the PR actually exists on GitHub (HEAD request)");
  const head = await fetch(prUrl!, { method: "HEAD", redirect: "follow" });
  assert(head.status === 200, `HEAD ${prUrl} → 200 (got ${head.status})`);

  // 6. Cleanup (sandbox should already be torn down by sweeper on completed,
  //    but call DELETE to be safe).
  if (!args.values["keep-sandbox"]) {
    section("Cleanup");
    const del = await http("DELETE", `${LAUNCHER}/sessions/${sessionId}`);
    info(`DELETE /sessions/${sessionId} → ${del.status}`);
  }

  // 7. Summary
  console.log(`\n\x1b[1mSummary:\x1b[0m ${stepCount} checks passed, ${failures} failed`);
  if (failures === 0) {
    console.log(`\x1b[32mPR created and verified:\x1b[0m ${prUrl}`);
    console.log(
      `Open it to review the agent's work, then close + delete the branch if you don't want it.`,
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

await main();
