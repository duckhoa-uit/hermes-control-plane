// Supervisor — runs as the sandbox's start command (baked into the E2B
// template via setStartCmd). It is started ONCE during template build, then
// captured in the template snapshot. When a sandbox is created from the
// template, this process is already running.
//
// It waits for the control plane to drop a per-session config file at
// /opt/hermes/start.json (written by src/launcher/provision.ts), reads
// env vars from it, then execs the real runner.
//
// Why this dance: env vars passed to Sandbox.create({ envs }) are NOT
// visible to the start command (which already ran at build time). So the
// control plane writes per-session secrets to a file after the sandbox
// boots; this supervisor polls that file and bridges them into the runner.

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";

const CONFIG_PATH = "/opt/hermes/start.json";
const RUNNER_PATH = "/opt/hermes/runner.js";
const POLL_INTERVAL_MS = 250;

interface StartConfig {
  HERMES_SESSION_ID: string;
  HERMES_RUNNER_TOKEN: string;
  HERMES_CONTROL_WS: string;
  ZHIPU_API_KEY?: string;
  OPENCODE_MODEL?: string;
  [k: string]: string | undefined;
}

function log(msg: string): void {
  console.log(`[supervisor] ${msg}`);
}

async function waitForConfig(): Promise<StartConfig> {
  log(`waiting for ${CONFIG_PATH}`);
  // Infinite poll; sandbox lifecycle will kill us if abandoned.
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

async function main(): Promise<void> {
  const cfg = await waitForConfig();
  log(`config loaded for session ${cfg.HERMES_SESSION_ID.slice(0, 8)}; exec runner`);

  const env: NodeJS.ProcessEnv = { ...process.env };
  // Ensure standard system bin dirs are on PATH so the runner can spawn
  // `opencode`, `git`, etc. The supervisor inherits whatever PATH the
  // template start command captured at build time, which may be minimal.
  const defaultPath = "/usr/local/bin:/usr/bin:/bin";
  env.PATH = env.PATH ? `${env.PATH}:${defaultPath}` : defaultPath;
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === "string") env[k] = v;
  }

  const proc = spawn("node", [RUNNER_PATH], {
    env,
    stdio: "inherit",
  });

  proc.on("exit", (code) => {
    log(`runner exited with code ${code ?? "null"}`);
    process.exit(code ?? 1);
  });
  proc.on("error", (err) => {
    log(`failed to spawn runner: ${err.message}`);
    process.exit(1);
  });
}

main().catch((err) => {
  log(`fatal: ${err.message}`);
  process.exit(1);
});
