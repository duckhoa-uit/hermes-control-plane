// Supervisor — runs as the sandbox's start command (baked into the E2B
// template via setStartCmd). It is started ONCE during template build, then
// captured in the template snapshot. When a sandbox is created from the
// template, this process is already running.
//
// Responsibilities (M4):
//   1. Spawn `opencode serve --hostname=127.0.0.1 --port=4096` immediately
//      and wait until it logs "opencode server listening". The snapshot
//      captures the listening socket so per-session boot is instant.
//   2. Poll /opt/hermes/start.json for per-session secrets (written by the
//      launcher after Sandbox.create()).
//   3. Once start.json arrives, PUT the Z.AI key into opencode via
//      /auth/zai-coding-plan so the SDK in the runner can prompt.
//   4. Spawn the runner (node /opt/hermes/runner.js) with the secrets in env.
//   5. Babysit both children — if either exits, kill the other and exit
//      with the same code. Avoids zombie processes / sandbox leaks.

import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { applyZaiAuthForTests as applyZaiAuth, babysitForTests as babysitImpl } from "./supervisor-helpers";

const CONFIG_PATH = "/opt/hermes/start.json";
const RUNNER_PATH = "/opt/hermes/runner.js";
const POLL_INTERVAL_MS = 250;
const OPENCODE_HOST = "127.0.0.1";
const OPENCODE_PORT = 4096;
const OPENCODE_READY_LOG = "/var/log/opencode-serve.log";
const SERVE_READY_TIMEOUT_MS = 30_000;
const SERVE_READY_LINE = "opencode server listening";

interface StartConfig {
  HERMES_SESSION_ID: string;
  HERMES_RUNNER_TOKEN: string;
  HERMES_CONTROL_WS: string;
  // M4: Z.AI key is applied via opencode REST auth.set, not env var.
  ZAI_API_KEY?: string;
  // Back-compat name (pre-M4 launcher might still emit ZHIPU_API_KEY).
  ZHIPU_API_KEY?: string;
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
  // Pipe to a log file so we can poll for the ready line without holding
  // stdout in this process (we want the supervisor to keep printing too).
  const proc = spawn(
    "bash",
    ["-c", `exec opencode serve --hostname=${OPENCODE_HOST} --port=${OPENCODE_PORT} > ${OPENCODE_READY_LOG} 2>&1`],
    { env: ensurePath({ ...process.env }), stdio: "ignore", detached: false },
  );

  // Poll the log for the ready line.
  const deadline = Date.now() + SERVE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(OPENCODE_READY_LOG)) {
      try {
        const out = readFileSync(OPENCODE_READY_LOG, "utf-8");
        if (out.includes(SERVE_READY_LINE)) {
          log(`opencode serve ready (pid=${proc.pid})`);
          return proc;
        }
      } catch {}
    }
    if (proc.exitCode !== null) {
      const out = existsSync(OPENCODE_READY_LOG) ? readFileSync(OPENCODE_READY_LOG, "utf-8") : "";
      throw new Error(`opencode serve died before ready (code=${proc.exitCode}); log:\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`opencode serve did not become ready in ${SERVE_READY_TIMEOUT_MS}ms`);
}

async function waitForConfig(): Promise<StartConfig> {
  log(`waiting for ${CONFIG_PATH}`);
  while (true) {
    if (existsSync(CONFIG_PATH)) {
      try {
        const raw = readFileSync(CONFIG_PATH, "utf-8");
        const cfg = JSON.parse(raw) as StartConfig;
        if (cfg.HERMES_SESSION_ID && cfg.HERMES_RUNNER_TOKEN && cfg.HERMES_CONTROL_WS) {
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
  log(`spawning runner (node ${RUNNER_PATH}) for session ${cfg.HERMES_SESSION_ID.slice(0, 8)}`);
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
  serve.on("error", (err) => { log(`serve spawn error: ${err.message}`); process.exit(1); });
  runner.on("error", (err) => { log(`runner spawn error: ${err.message}`); process.exit(1); });
}

async function main(): Promise<void> {
  // 1. Start opencode serve early so the snapshot captures it warm.
  const serveProc = await spawnOpencodeServe();

  // 2. Block until launcher writes per-session secrets.
  const cfg = await waitForConfig();
  log(`config loaded for session ${cfg.HERMES_SESSION_ID.slice(0, 8)}`);

  // 3. Apply Z.AI credentials to opencode.
  const zaiKey = cfg.ZAI_API_KEY || cfg.ZHIPU_API_KEY || "";
  if (!zaiKey) {
    log("WARNING: no ZAI_API_KEY / ZHIPU_API_KEY in start.json; runner prompts will fail");
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
