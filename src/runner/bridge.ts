// ============================================================
// Hermes Runner / Bridge
// Runs inside E2B sandbox. Connects to SessionDO via WebSocket.
// Starts opencode serve, subscribes to SSE, normalizes events.
// ============================================================

import type { RunnerCommand } from "../core/types";
import { HEARTBEAT_INTERVAL_MS, OPENCODE_PORT } from "../core/constants";

// ---- Config from env ----

const SESSION_ID = process.env.CONTROL_PLANE_SESSION_ID!;
const RUNNER_TOKEN = process.env.CONTROL_PLANE_RUNNER_TOKEN!;
const CONTROL_WS_URL = process.env.HERMES_CONTROL_WS_URL!;

if (!SESSION_ID || !RUNNER_TOKEN || !CONTROL_WS_URL) {
  console.error("Missing required env vars: CONTROL_PLANE_SESSION_ID, CONTROL_PLANE_RUNNER_TOKEN, HERMES_CONTROL_WS_URL");
  process.exit(1);
}

// ---- State ----

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;
const ackedCommands = new Set<string>();

// ---- Connect to control plane ----

function connectControlPlane(): void {
  const url = new URL(CONTROL_WS_URL);
  url.searchParams.set("role", "runner");
  url.searchParams.set("token", RUNNER_TOKEN);

  console.log(`[runner] Connecting to control plane: ${url.toString()}`);

  ws = new WebSocket(url.toString());

  ws.addEventListener("open", () => {
    console.log("[runner] Connected to control plane");
    reconnectAttempts = 0;
    startHeartbeat();
  });

  ws.addEventListener("message", async (e) => {
    try {
      const msg = JSON.parse(e.data as string);
      await handleControlMessage(msg);
    } catch (err) {
      console.error("[runner] Error handling message:", err);
    }
  });

  ws.addEventListener("close", (ev: CloseEvent) => {
    console.log(`[runner] WS closed: ${ev.code} ${ev.reason}`);
    stopHeartbeat();
    ws = null;

    if (reconnectAttempts < MAX_RECONNECT) {
      reconnectAttempts++;
      const delay = Math.min(1000 * 2 ** reconnectAttempts, 10_000);
      console.log(`[runner] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
      setTimeout(() => connectControlPlane(), delay);
    } else {
      console.error("[runner] Max reconnect attempts reached, exiting");
      process.exit(1);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[runner] WS error:", err);
  });
}

// ---- Heartbeat ----

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "runner.heartbeat", sessionId: SESSION_ID }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ---- Send messages to control plane ----

function sendToControl(msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendEvent(
  eventType: string,
  eventPayload: Record<string, unknown>,
): void {
  sendToControl({
    type: "runner.event",
    sessionId: SESSION_ID,
    payload: { eventType, eventPayload },
  });
}

function sendCommandAck(commandId: string): void {
  if (ackedCommands.has(commandId)) return;
  ackedCommands.add(commandId);
  sendToControl({ type: "runner.command_ack", sessionId: SESSION_ID, payload: { commandId } });
}

function sendComplete(payload: Record<string, unknown>): void {
  sendToControl({ type: "runner.complete", sessionId: SESSION_ID, payload });
}

function sendError(error: string): void {
  sendToControl({ type: "runner.error", sessionId: SESSION_ID, payload: { error } });
}

// ---- Handle commands from control plane ----

async function handleControlMessage(msg: { type: string; command?: RunnerCommand }): Promise<void> {
  if (msg.type !== "command" || !msg.command) return;

  const cmd = msg.command;
  console.log(`[runner] Received command: ${cmd.type} (${cmd.commandId})`);

  try {
    switch (cmd.type) {
      case "agent.prompt":
        await handleAgentPrompt(cmd);
        break;
      case "agent.abort":
        await handleAbort(cmd);
        break;
      case "approval.grant":
        sendCommandAck(cmd.commandId);
        break;
      case "approval.deny":
        sendCommandAck(cmd.commandId);
        break;
      case "pr.create":
        await handleCreatePR(cmd);
        break;
      case "session.shutdown":
        console.log("[runner] Shutdown command received");
        sendCommandAck(cmd.commandId);
        await cleanup();
        process.exit(0);
        break;
      default:
        console.warn(`[runner] Unknown command type: ${cmd.type}`);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    sendToControl({
      type: "runner.command_error",
      sessionId: SESSION_ID,
      payload: { commandId: cmd.commandId, error: errorMsg },
    });
  }
}

// ---- Agent prompt handling ----

async function handleAgentPrompt(cmd: RunnerCommand): Promise<void> {
  const { taskDescription, context, model, allowedTools } = cmd.payload as {
    taskDescription: string;
    context: string;
    model: string;
    allowedTools: string[];
  };

  sendCommandAck(cmd.commandId);
  sendEvent("agent.started", { taskDescription });

  try {
    // Use opencode CLI to run the task
    const fullPrompt = `${context}\n\n## Task\n${taskDescription}`;
    const result = await runOpenCodeTask(fullPrompt, model);

    // Collect artifacts
    const diff = await getGitDiff();
    const changedFiles = await getChangedFiles();
    const testResult = await runTests();

    sendEvent("agent.done", { summary: result });
    sendComplete({
      summary: result,
      diff,
      changedFiles,
      testResult,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    sendEvent("agent.error", { error: errorMsg });
    sendError(errorMsg);
  }
}

// ---- OpenCode integration ----

async function runOpenCodeTask(prompt: string, model: string): Promise<string> {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    const proc = spawn(
      "opencode",
      ["run", "--model", model, prompt],
      {
        cwd: "/home/user/repo",
        env: { ...process.env, OPENCODE_MODEL: model },
      },
    );

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Stream deltas to control plane
      sendEvent("agent.message.delta", { text: chunk.toString() });
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        sendEvent("agent.message.complete", { text: stdout });
        resolve(stdout);
      } else {
        reject(new Error(`opencode exited with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn opencode: ${err.message}`));
    });
  });
}

async function getGitDiff(): Promise<string> {
  const { exec } = await import("node:child_process");
  return new Promise((resolve) => {
    exec("git diff", { cwd: "/home/user/repo" }, (_err, stdout) => {
      resolve(stdout || "");
    });
  });
}

async function getChangedFiles(): Promise<string[]> {
  const { exec } = await import("node:child_process");
  return new Promise((resolve) => {
    exec("git diff --name-only", { cwd: "/home/user/repo" }, (_err, stdout) => {
      const files = stdout.trim().split("\n").filter(Boolean);
      resolve(files);
    });
  });
}

async function runTests(): Promise<{ passed: boolean; total: number; failed: number; output: string } | undefined> {
  // Check if test script exists
  const fs = await import("node:fs");
  const testScriptPath = "/home/user/repo/.hermes/test.sh";

  if (!fs.existsSync(testScriptPath)) {
    return undefined;
  }

  const { exec } = await import("node:child_process");
  return new Promise((resolve) => {
    exec("bash .hermes/test.sh", { cwd: "/home/user/repo" }, (err, stdout, stderr) => {
      const output = stdout + stderr;
      const exitCode = err?.code ?? 0;
      resolve({
        passed: exitCode === 0,
        total: 0,
        failed: exitCode === 0 ? 0 : 1,
        output,
      });
    });
  });
}

// ---- Abort ----

async function handleAbort(cmd: RunnerCommand): Promise<void> {
  sendCommandAck(cmd.commandId);
  await cleanup();
}

// ---- PR creation ----

async function handleCreatePR(cmd: RunnerCommand): Promise<void> {
  const { branch } = cmd.payload as { branch: string };
  sendCommandAck(cmd.commandId);

  const { exec } = await import("node:child_process");

  // Push branch
  await new Promise<void>((resolve, reject) => {
    exec(`git push origin ${branch}`, { cwd: "/home/user/repo" }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  sendEvent("git.branch.pushed", { branch });

  // Create PR via gh CLI if available
  const prUrl = await new Promise<string>((resolve, reject) => {
    exec(
      'gh pr create --title "Hermes: automated task" --body "Generated by Hermes control plane" --base main',
      { cwd: "/home/user/repo" },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      },
    );
  }).catch(() => "");

  if (prUrl) {
    sendEvent("pr.created", { url: prUrl });
  }

  sendComplete({ prUrl });
}

// ---- Cleanup ----

async function cleanup(): Promise<void> {
  stopHeartbeat();
  if (ws?.readyState === WebSocket.OPEN) {
    ws.close(1000, "cleanup");
  }
}

// ---- Main ----

console.log(`[runner] Hermes runner starting for session ${SESSION_ID}`);
connectControlPlane();
