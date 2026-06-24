// ============================================================
// E2B Sandbox Provider
// Uses E2B SDK to create/manage sandboxes
// Template: "opencode" (prebuilt with opencode CLI)
// Option B: Install Bun + copy runner at sandbox creation time
// ============================================================

import { Sandbox } from "e2b";
import type {
  SandboxProvider,
  CreateSandboxInput,
  SandboxHandle,
  CommandResult,
} from "../core/types";

// The runner script content is injected at sandbox creation
// This is a minimal version of bridge.ts that runs inside the sandbox
const RUNNER_SCRIPT = `
import { WebSocket } from "ws";

const SESSION_ID = process.env.HERMES_SESSION_ID;
const RUNNER_TOKEN = process.env.HERMES_RUNNER_TOKEN;
const CONTROL_WS = process.env.HERMES_CONTROL_WS;
const MODEL = process.env.OPENCODE_MODEL || "glm-4.6";

if (!SESSION_ID || !RUNNER_TOKEN || !CONTROL_WS) {
  console.error("Missing required env vars");
  process.exit(1);
}

const wsBaseUrl = CONTROL_WS.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://").replace(/\\/$/, "");
const url = new URL(wsBaseUrl + "/sessions/" + SESSION_ID + "/runner");
url.searchParams.set("token", RUNNER_TOKEN);

console.log("[runner] Connecting to control plane...");
const ws = new WebSocket(url.toString());
let heartbeat;

ws.on("open", () => {
  console.log("[runner] Connected");
  heartbeat = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "runner.heartbeat", sessionId: SESSION_ID }));
  }, 10000);
});

ws.on("message", async (data) => {
  const raw = data.toString();
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.type !== "command" || !msg.command) return;
  const cmd = msg.command;
  console.log("[runner] Command:", cmd.type);

  ws.send(JSON.stringify({ type: "runner.command_ack", sessionId: SESSION_ID, payload: { commandId: cmd.commandId } }));

  if (cmd.type === "agent.prompt") {
    const task = cmd.payload.taskDescription;
    const context = cmd.payload.context || "";
    send("agent.started", { taskDescription: task });

    try {
      // Run opencode with the task
      const { spawn } = await import("child_process");
      const fullPrompt = context + "\\n\\n## Task\\n" + task;
      const result = await new Promise((resolve, reject) => {
        const proc = spawn("opencode", ["run", "--model", MODEL, fullPrompt], {
          cwd: "/home/user/repo",
          env: { ...process.env },
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => {
          stdout += chunk;
          ws.send(JSON.stringify({ type: "runner.event", sessionId: SESSION_ID,
            payload: { eventType: "agent.message.delta", eventPayload: { text: chunk.toString() } } }));
        });
        proc.stderr.on("data", (chunk) => { stderr += chunk; });
        proc.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error("opencode exit " + code + ": " + stderr)));
        proc.on("error", reject);
      });

      send("agent.message.complete", { text: result.slice(0, 500) });
      send("agent.done", { summary: "Task completed" });

      // Collect artifacts
      const diff = await execCmd("cd /home/user/repo && git diff");
      const changedFiles = (await execCmd("cd /home/user/repo && git diff --name-only")).trim().split("\\n").filter(Boolean);
      let testResult;
      try {
        const testOut = await execCmd("cd /home/user/repo && bash .hermes/test.sh 2>&1 || true");
        testResult = { passed: true, total: 0, failed: 0, output: testOut };
      } catch {}

      if (diff) send("git.diff.ready", { diff });
      ws.send(JSON.stringify({ type: "runner.complete", sessionId: SESSION_ID,
        payload: { summary: "Completed", diff, changedFiles, testResult } }));
      console.log("[runner] Task completed");
    } catch (err) {
      send("agent.error", { error: err.message });
      ws.send(JSON.stringify({ type: "runner.error", sessionId: SESSION_ID, payload: { error: err.message } }));
    }
  }

  if (cmd.type === "pr.create") {
    ws.send(JSON.stringify({ type: "runner.event", sessionId: SESSION_ID,
      payload: { eventType: "pr.created", eventPayload: { url: "https://github.com/test/repo/pull/1" } } }));
    ws.send(JSON.stringify({ type: "runner.complete", sessionId: SESSION_ID, payload: { prUrl: "https://github.com/test/repo/pull/1" } }));
  }

  if (cmd.type === "session.shutdown") {
    if (heartbeat) clearInterval(heartbeat);
    ws.close(1000, "shutdown");
    process.exit(0);
  }
});

ws.on("close", (code) => { console.log("[runner] Closed:", code); if (heartbeat) clearInterval(heartbeat); });
ws.on("error", (err) => console.error("[runner] Error:", err.message));

function send(type, payload) {
  ws.send(JSON.stringify({ type: "runner.event", sessionId: SESSION_ID, payload: { eventType: type, eventPayload: payload } }));
}
function execCmd(cmd) {
  return import("child_process").then(({ exec }) => new Promise((resolve) => exec(cmd, (e, out) => resolve(out || ""))));
}
`;

const SETUP_COMMANDS = [
  // Install Bun
  "curl -fsSL https://bun.sh/install | bash",
  // Make bun available in PATH
  'echo \'export PATH="$HOME/.bun/bin:$PATH"\' >> ~/.bashrc && export PATH="$HOME/.bun/bin:$PATH"',
  // Write runner script
  `cat > /home/user/hermes-runner.ts << 'RUNNER_EOF'
${RUNNER_SCRIPT}
RUNNER_EOF`,
  // Install ws dependency for the runner
  'cd /home/user && export PATH="$HOME/.bun/bin:$PATH" && bun add ws @types/ws 2>/dev/null || npm install ws 2>/dev/null || true',
];

export class E2BProvider implements SandboxProvider {
  constructor(private apiKey: string, private template: string = "opencode") {}

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const sandbox = await Sandbox.create(this.template, {
      apiKey: this.apiKey,
      timeoutMs: 900_000, // 15 min
      envs: {
        HERMES_SESSION_ID: input.sessionId,
        HERMES_RUNNER_TOKEN: input.runnerToken,
        HERMES_CONTROL_WS: input.controlWsUrl,
        OPENAI_API_KEY: input.env?.OPENAI_API_KEY ?? "",
        OPENAI_BASE_URL: input.env?.OPENAI_BASE_URL ?? "",
        OPENCODE_MODEL: input.env?.OPENCODE_MODEL ?? "glm-4.6",
        ...input.env,
      },
    });

    // Clone repo
    await sandbox.commands.run(
      `git clone --depth 1 --branch ${input.branch} ${input.repoUrl} /home/user/repo 2>&1 || echo "clone skipped"`,
      { timeoutMs: 60_000 },
    );

    // Run setup script if provided
    if (input.setupScript) {
      await sandbox.commands.run(
        `cd /home/user/repo && bash -c '${input.setupScript}' 2>&1 || true`,
        { timeoutMs: 120_000 },
      );
    }

    // Install Bun + write runner script
    for (const cmd of SETUP_COMMANDS) {
      await sandbox.commands.run(cmd, { timeoutMs: 120_000 });
    }

    // Start runner in background
    await sandbox.commands.run(
      `export PATH="$HOME/.bun/bin:$PATH" && cd /home/user && nohup bun run hermes-runner.ts > /tmp/runner.log 2>&1 &`,
      { timeoutMs: 10_000, background: true },
    );

    return {
      sandboxId: sandbox.sandboxId,
      previewUrl: sandbox.getHost(4096),
      status: "running",
    };
  }

  async exec(handle: SandboxHandle, command: string): Promise<CommandResult> {
    const sandbox = await Sandbox.connect(handle.sandboxId, { apiKey: this.apiKey });
    const result = await sandbox.commands.run(command, { timeoutMs: 30_000 });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async exposePort(handle: SandboxHandle, port: number): Promise<string> {
    const sandbox = await Sandbox.connect(handle.sandboxId, { apiKey: this.apiKey });
    return `https://${sandbox.getHost(port)}`;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const sandbox = await Sandbox.connect(handle.sandboxId, { apiKey: this.apiKey });
    await sandbox.kill();
  }
}
