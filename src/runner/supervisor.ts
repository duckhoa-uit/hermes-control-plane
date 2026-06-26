// Supervisor — runs as the sandbox's start command (baked into the E2B
// template via setStartCmd). It is started ONCE during template build, then
// captured in the template snapshot. When a sandbox is created from the
// template, this process is already running.
//
// Responsibilities (M4):
//   1. Spawn `opencode serve --hostname=127.0.0.1 --port=4096` immediately
//      and wait until it logs "opencode server listening". The snapshot
//      captures the listening socket so per-session boot is instant.
//   2. Poll /opt/control-plane/start.json for per-session secrets (written by the
//      launcher after Sandbox.create()).
//   3. Once start.json arrives, PUT the Z.AI key into opencode via
//      /auth/zai-coding-plan so the SDK in the runner can prompt.
//   4. Spawn the runner (node /opt/control-plane/runner.js) with the secrets in env.
//   5. Babysit both children — if either exits, kill the other and exit
//      with the same code. Avoids zombie processes / sandbox leaks.

import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import {
  applyZaiAuthForTests as applyZaiAuth,
  babysitForTests as babysitImpl,
} from "./supervisor-helpers";

const CONFIG_PATH = "/opt/control-plane/start.json";
const RUNNER_PATH = "/opt/control-plane/runner.js";
const POLL_INTERVAL_MS = 250;
const OPENCODE_HOST = "127.0.0.1";
const OPENCODE_PORT = 4096;
const OPENCODE_READY_LOG = "/var/log/opencode-serve.log";
const SERVE_READY_TIMEOUT_MS = 120_000;

interface StartConfig {
  CONTROL_PLANE_SESSION_ID: string;
  CONTROL_PLANE_RUNNER_TOKEN: string;
  CONTROL_PLANE_WS_URL: string;
  // M4: Z.AI key is applied via opencode REST auth.set, not env var.
  ZAI_API_KEY?: string;
  [k: string]: string | undefined;
}

function log(msg: string): void {
  console.log(`[supervisor] ${msg}`);
}

function ensurePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The template start command may have captured a minimal PATH at build
  // time. Make sure standard bin dirs are present.
  const defaultPath = "/usr/local/bin:/usr/bin:/bin";
  env.PATH = env.PATH ? `${env.PATH}:${defaultPath}` : defaultPath;
  return env;
}

async function spawnOpencodeServe(): Promise<ChildProcess> {
  log(`spawning opencode serve on ${OPENCODE_HOST}:${OPENCODE_PORT}`);

  // Fast path: opencode may already be listening from a previous boot —
  // either captured live in the template snapshot (E2B's setStartCmd
  // waitForPort(4096) snapshots the moment the port opens, which is BEFORE
  // this poll loop sees the log line) or kept alive by `lifecycle:
  // autoResume`. If a TCP probe succeeds we don't need a fresh process.
  if (await isPortListening(OPENCODE_HOST, OPENCODE_PORT)) {
    log(`opencode serve already listening (snapshot/resume); skipping respawn`);
    // Return a sentinel: nothing to babysit because the process was started
    // by the snapshot's init, not by us. babysit() handles undefined.
    return { pid: undefined, exitCode: null, kill: () => {} } as unknown as ChildProcess;
  }

  const proc = spawn(
    "bash",
    [
      "-c",
      `exec opencode serve --hostname=${OPENCODE_HOST} --port=${OPENCODE_PORT} > ${OPENCODE_READY_LOG} 2>&1`,
    ],
    { env: ensurePath({ ...process.env }), stdio: "ignore", detached: false },
  );

  // Poll for readiness. We use a fresh deadline (resets every call) so a
  // sandbox resumed long after build-time snapshot doesn't compare against
  // a stale Date.now() captured in the snapshot's closure.
  const deadline = Date.now() + SERVE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Prefer a real TCP probe over log scraping — the log file write can
    // race with the listen() syscall, especially when the snapshot fires
    // on waitForPort but our poll loop hasn't read the buffered log yet.
    if (await isPortListening(OPENCODE_HOST, OPENCODE_PORT)) {
      log(`opencode serve ready (port ${OPENCODE_PORT} open, pid=${proc.pid})`);
      return proc;
    }
    if (proc.exitCode !== null) {
      const out = existsSync(OPENCODE_READY_LOG) ? readFileSync(OPENCODE_READY_LOG, "utf-8") : "";
      throw new Error(`opencode serve died before ready (code=${proc.exitCode}); log:\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`opencode serve did not become ready in ${SERVE_READY_TIMEOUT_MS}ms`);
}

function isPortListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- baked supervisor must be sync-loadable from the snapshot, ESM-only `import { Socket } from "node:net"` breaks pkg-bundling.
    const net = require("node:net");
    const Socket = net.Socket;
    const sock = new Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(ok);
    };
    sock.setTimeout(500);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.once("timeout", () => finish(false));
    sock.connect(port, host);
  });
}

async function waitForConfig(): Promise<StartConfig> {
  log(`waiting for ${CONFIG_PATH}`);
  while (true) {
    if (existsSync(CONFIG_PATH)) {
      try {
        const raw = readFileSync(CONFIG_PATH, "utf-8");
        const cfg = JSON.parse(raw) as StartConfig;
        if (
          cfg.CONTROL_PLANE_SESSION_ID &&
          cfg.CONTROL_PLANE_RUNNER_TOKEN &&
          cfg.CONTROL_PLANE_WS_URL
        ) {
          return cfg;
        }
        log(`config file present but missing required keys; re-polling`);
      } catch (err) {
        log(`failed to parse config: ${(err as Error).message}; re-polling`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function applyZaiAuthLog(apiKey: string): Promise<void> {
  const url = `http://${OPENCODE_HOST}:${OPENCODE_PORT}`;
  log(`PUT ${url}/auth/zai-coding-plan (auth.set)`);
  await applyZaiAuth(url, apiKey);
}

function spawnRunner(cfg: StartConfig): ChildProcess {
  log(
    `spawning runner (node ${RUNNER_PATH}) for session ${cfg.CONTROL_PLANE_SESSION_ID.slice(0, 8)}`,
  );
  const env: NodeJS.ProcessEnv = ensurePath({ ...process.env });
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === "string") env[k] = v;
  }
  // Always export the opencode server URL so the runner doesn't have to
  // hard-code it.
  env.OPENCODE_BASE_URL = `http://${OPENCODE_HOST}:${OPENCODE_PORT}`;
  return spawn("node", [RUNNER_PATH], { env, stdio: "inherit" });
}

function babysit(serve: ChildProcess, runner: ChildProcess): void {
  babysitImpl(serve, runner, (code) => {
    log(`peer exited; supervisor exiting with code ${code}`);
    process.exit(code ?? 1);
  });
  serve.on("error", (err) => {
    log(`serve spawn error: ${err.message}`);
    process.exit(1);
  });
  runner.on("error", (err) => {
    log(`runner spawn error: ${err.message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  // 1. Start opencode serve early so the snapshot captures it warm.
  const serveProc = await spawnOpencodeServe();

  // 2. Block until launcher writes per-session secrets.
  const cfg = await waitForConfig();
  log(`config loaded for session ${cfg.CONTROL_PLANE_SESSION_ID.slice(0, 8)}`);

  // 3. Apply Z.AI credentials to opencode.
  const zaiKey = cfg.ZAI_API_KEY || "";
  if (!zaiKey) {
    log("WARNING: no ZAI_API_KEY in start.json; runner prompts will fail");
  } else {
    try {
      await applyZaiAuthLog(zaiKey);
    } catch (err) {
      log(`auth.set failed: ${(err as Error).message}; runner will likely fail`);
    }
  }

  // 4. Spawn the runner.
  const runnerProc = spawnRunner(cfg);

  // 5. Babysit both.
  babysit(serveProc, runnerProc);
}

main().catch((err) => {
  log(`fatal: ${err.message}`);
  process.exit(1);
});
