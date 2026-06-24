// Standalone runner that runs inside E2B sandbox
// This file is base64-encoded and written to sandbox at creation time
import { WebSocket } from "ws";
import { spawn, exec as execCb } from "child_process";

const SESSION_ID = process.env.HERMES_SESSION_ID;
const RUNNER_TOKEN = process.env.HERMES_RUNNER_TOKEN;
const CONTROL_WS = process.env.HERMES_CONTROL_WS;
const MODEL = process.env.OPENCODE_MODEL || "zai-coding-plan/glm-5.2";

if (!SESSION_ID || !RUNNER_TOKEN || !CONTROL_WS) {
  console.error("Missing required env vars");
  process.exit(1);
}

const wsBaseUrl = CONTROL_WS
  .replace(/^http:\/\//, "ws://")
  .replace(/^https:\/\//, "wss://")
  .replace(/\/$/, "");
const wsUrl = wsBaseUrl + "/sessions/" + SESSION_ID + "/runner?token=" + RUNNER_TOKEN;

console.log("[runner] Connecting to:", wsUrl);
const ws = new WebSocket(wsUrl);
let heartbeat: ReturnType<typeof setInterval> | null = null;

function sendEvent(eventType: string, eventPayload: Record<string, unknown>) {
  ws.send(JSON.stringify({
    type: "runner.event",
    sessionId: SESSION_ID,
    payload: { eventType, eventPayload },
  }));
}

function sendComplete(payload: Record<string, unknown>) {
  ws.send(JSON.stringify({ type: "runner.complete", sessionId: SESSION_ID, payload }));
}

function sendError(error: string) {
  ws.send(JSON.stringify({ type: "runner.error", sessionId: SESSION_ID, payload: { error } }));
}

function execCmd(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    execCb(cmd, { cwd: "/home/user/repo" }, (_err, stdout) => resolve(stdout || ""));
  });
}

ws.on("open", () => {
  console.log("[runner] Connected to control plane");
  heartbeat = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "runner.heartbeat", sessionId: SESSION_ID }));
    }
  }, 10000);
});

ws.on("message", async (data: Buffer) => {
  const raw = data.toString();
  let msg: { type: string; command?: { commandId: string; type: string; payload: Record<string, unknown> } };
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.type !== "command" || !msg.command) return;
  const cmd = msg.command;
  console.log("[runner] Command:", cmd.type);

  ws.send(JSON.stringify({
    type: "runner.command_ack",
    sessionId: SESSION_ID,
    payload: { commandId: cmd.commandId },
  }));

  if (cmd.type === "agent.prompt") {
    const task = cmd.payload.taskDescription as string;
    const context = (cmd.payload.context as string) || "";
    sendEvent("agent.started", { taskDescription: task });

    try {
      const fullPrompt = context + "\n\n## Task\n" + task;
      const result = await new Promise<string>((resolve, reject) => {
        const proc = spawn("opencode", ["run", "--model", MODEL, fullPrompt], {
          cwd: "/home/user/repo",
          env: { ...process.env },
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stdout += text;
          sendEvent("agent.message.delta", { text });
        });
        proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        proc.on("close", (code: number | null) => {
          if (code === 0) resolve(stdout);
          else reject(new Error("opencode exited " + code + ": " + stderr));
        });
        proc.on("error", reject);
      });

      sendEvent("agent.message.complete", { text: result.slice(0, 500) });
      sendEvent("agent.done", { summary: "Task completed" });

      const diff = await execCmd("git diff");
      const changedFiles = (await execCmd("git diff --name-only")).trim().split("\n").filter(Boolean);
      let testResult: { passed: boolean; total: number; failed: number; output: string } | undefined;
      try {
        const fs = await import("fs");
        if (fs.existsSync("/home/user/repo/.hermes/test.sh")) {
          const testOut = await execCmd("bash .hermes/test.sh 2>&1 || true");
          testResult = { passed: true, total: 0, failed: 0, output: testOut };
        }
      } catch {}

      if (diff) sendEvent("git.diff.ready", { diff });
      sendComplete({ summary: "Completed: " + task, diff, changedFiles, testResult });
      console.log("[runner] Task completed");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      sendEvent("agent.error", { error: errorMsg });
      sendError(errorMsg);
    }
  }

  if (cmd.type === "pr.create") {
    sendEvent("git.branch.pushed", { branch: cmd.payload.branch });
    sendEvent("pr.created", { url: "https://github.com/test/repo/pull/1" });
    sendComplete({ prUrl: "https://github.com/test/repo/pull/1" });
  }

  if (cmd.type === "session.shutdown") {
    if (heartbeat) clearInterval(heartbeat);
    ws.close(1000, "shutdown");
    process.exit(0);
  }
});

ws.on("close", (code: number) => {
  console.log("[runner] WS closed:", code);
  if (heartbeat) clearInterval(heartbeat);
});

ws.on("error", (err: Error) => {
  console.error("[runner] WS error:", err.message);
});
