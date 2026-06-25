// ============================================================
// Build the hermes E2B sandbox template.
//
// Bakes into the snapshot:
//   - Node 22 + npm + git + curl (from fromNodeImage)
//   - opencode CLI (latest)
//   - The supervisor (Node-runnable, bundled) at /opt/hermes/supervisor.js
//   - The runner (Node-runnable, bundled) at /opt/hermes/runner.js
//   - /opt/hermes (where the per-session start.json is dropped at runtime)
//   - Start command launches the supervisor; readiness check ensures it is up
//
// At runtime the launcher (src/launcher/provision.ts) only:
//   1. Sandbox.create(templateId, { lifecycle: { onTimeout: 'pause', autoResume: true } })
//   2. sandbox.files.write('/opt/hermes/start.json', JSON.stringify(env))
//      -> the snapshotted supervisor wakes and execs the runner.
//
// Run (Hobby tier OK; build takes a couple of minutes the first time, near-
// instant on subsequent runs thanks to layer caching):
//   E2B_API_KEY=... bun run infra/e2b/build-template.ts
// ============================================================

import { Template, defaultBuildLogger, waitForPort } from "e2b";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..", "..");
const SUPERVISOR_SRC = resolve(ROOT, "src/runner/supervisor.ts");
const RUNNER_SRC = resolve(ROOT, "src/runner/sandbox-runner.ts");
const OUT_DIR = resolve(ROOT, "infra/e2b/dist");
const SUPERVISOR_OUT = resolve(OUT_DIR, "supervisor.js");
const RUNNER_OUT = resolve(OUT_DIR, "runner.js");

const TEMPLATE_NAME = process.env.HERMES_TEMPLATE_NAME ?? "hermes-runner";

if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is required");
  process.exit(1);
}

// `Bun` is available as a global when this script is run via `bun run`.
declare const Bun: {
  build(opts: {
    entrypoints: string[];
    target: "node" | "bun" | "browser";
    format?: "cjs" | "esm";
    outdir?: string;
    naming?: string;
    external?: string[];
    minify?: boolean;
  }): Promise<{ success: boolean; logs: unknown[] }>;
};

async function bundleArtifacts(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log("[build] bundling supervisor + runner with Bun.build");

  const sup = await Bun.build({
    entrypoints: [SUPERVISOR_SRC],
    target: "node",
    format: "cjs",
    outdir: OUT_DIR,
    naming: "supervisor.js",
  });
  if (!sup.success) {
    console.error("[build] supervisor bundle failed:", sup.logs);
    process.exit(1);
  }

  const run = await Bun.build({
    entrypoints: [RUNNER_SRC],
    target: "node",
    format: "cjs",
    outdir: OUT_DIR,
    naming: "runner.js",
  });
  if (!run.success) {
    console.error("[build] runner bundle failed:", run.logs);
    process.exit(1);
  }

  if (!existsSync(SUPERVISOR_OUT) || !existsSync(RUNNER_OUT)) {
    throw new Error("bundled outputs missing");
  }
  console.log(
    `[build] supervisor=${readFileSync(SUPERVISOR_OUT).length}B runner=${readFileSync(RUNNER_OUT).length}B`,
  );
}

async function buildTemplate(): Promise<void> {
  await bundleArtifacts();

  console.log(`[build] defining template: ${TEMPLATE_NAME}`);

  const template = Template()
    .fromNodeImage("22")
    // Build-time mutations (npm -g, mkdir under /opt and /var) need root.
    .setUser("root")
    .runCmd("npm install -g opencode-ai@1.17.10")
    .makeDir("/opt/hermes")
    .makeDir("/var/log")
    .copy("dist/supervisor.js", "/opt/hermes/supervisor.js")
    .copy("dist/runner.js", "/opt/hermes/runner.js")
    // The runner does git operations as /home/user/repo's owner, so make sure
    // the user owns it.
    .runCmd("mkdir -p /home/user/repo && chown -R user:user /home/user /opt/hermes /var/log")
    // Back to the default unprivileged user for runtime.
    .setUser("user")
    .setStartCmd(
      "node /opt/hermes/supervisor.js > /var/log/hermes-supervisor.log 2>&1",
      // M4: supervisor spawns `opencode serve` on port 4096 BEFORE waiting
      // for /opt/hermes/start.json. We wait for the port to listen so the
      // snapshot captures opencode warm.
      waitForPort(4096),
    );

  console.log(`[build] starting Template.build() (this can take a few minutes the first time)`);
  const info = await Template.build(template, TEMPLATE_NAME, {
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });

  console.log("[build] success");
  console.log(JSON.stringify(info, null, 2));

  const idFile = resolve(OUT_DIR, "template-id.txt");
  writeFileSync(idFile, (info as { templateId: string }).templateId);
  console.log(`[build] template id written to ${idFile}`);
  console.log(`[build] set E2B_TEMPLATE = ${(info as { templateId: string }).templateId} (or '${TEMPLATE_NAME}') in wrangler.toml / .dev.vars`);
}

buildTemplate().catch((err) => {
  console.error("[build] FAILED:", err);
  process.exit(1);
});
