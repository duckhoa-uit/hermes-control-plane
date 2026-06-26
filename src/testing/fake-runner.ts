// ============================================================
// Fake Runner - simulates Bun bridge for local testing
// Connects to SessionDO via WebSocket, sends fake events,
// responds to commands. No E2B or OpenCode needed.
// ============================================================

import { WebSocket } from "ws";

const CONTROL_WS_URL = process.argv[2] ?? "ws://localhost:8787";
const SESSION_ID = process.argv[3] ?? "";
const RUNNER_TOKEN = process.argv[4] ?? "";

if (!SESSION_ID || !RUNNER_TOKEN) {
  console.error("Usage: bun run src/testing/fake-runner.ts <ws-url> <session-id> <runner-token>");
  process.exit(1);
}

console.log(`[fake-runner] Connecting to ${CONTROL_WS_URL} for session ${SESSION_ID}`);

// Runner connects to /sessions/:id/runner?token=<token>
// Convert http(s):// to ws(s):// for WebSocket
const wsBaseUrl = CONTROL_WS_URL.replace(/^http:\/\//, "ws://")
  .replace(/^https:\/\//, "wss://")
  .replace(/\/$/, "");
const url = new URL(`${wsBaseUrl}/sessions/${SESSION_ID}/runner`);
url.searchParams.set("token", RUNNER_TOKEN);

const ws = new WebSocket(url.toString());
let heartbeat: ReturnType<typeof setInterval> | null = null;

ws.on("open", () => {
  console.log("[fake-runner] Connected to control plane");

  // Start heartbeat
  heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "runner.heartbeat", sessionId: SESSION_ID }));
    }
  }, 5000);
});

ws.on("message", async (data: Buffer) => {
  const raw = data.toString();
  console.log(`[fake-runner] << ${raw.slice(0, 150)}`);

  let msg: {
    type: string;
    command?: { commandId: string; type: string; payload: Record<string, unknown> };
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    console.log("[fake-runner] Failed to parse message");
    return;
  }

  if (msg.type === "session_state") {
    console.log("[fake-runner] Session state:", JSON.stringify(msg, null, 2));
    return;
  }

  if (msg.type === "replay") {
    console.log(`[fake-runner] Received ${msg?.command ? 0 : 0} replay events`);
    return;
  }

  if (msg.type !== "command" || !msg.command) return;

  const cmd = msg.command;
  console.log(`[fake-runner] Received command: ${cmd.type} (${cmd.commandId})`);

  // Ack command
  ws.send(
    JSON.stringify({
      type: "runner.command_ack",
      sessionId: SESSION_ID,
      payload: { commandId: cmd.commandId },
    }),
  );

  // Handle command types
  switch (cmd.type) {
    case "agent.prompt": {
      const task = cmd.payload.taskDescription as string;
      console.log(`[fake-runner] Task: ${task}`);

      // Simulate agent working
      const events = [
        { type: "agent.started", payload: { taskDescription: task } },
        { type: "agent.message.delta", payload: { text: "Analyzing repo structure...\n" } },
        { type: "tool.started", payload: { tool: "read", callId: "call_1", path: "package.json" } },
        { type: "tool.completed", payload: { callId: "call_1", exitCode: 0 } },
        { type: "file.changed", payload: { path: "src/index.ts" } },
        { type: "agent.message.delta", payload: { text: "Implementing fix...\n" } },
        { type: "agent.message.complete", payload: { text: "Done. Fixed the issue." } },
      ];

      // Send events with small delay
      for (const ev of events) {
        ws.send(
          JSON.stringify({
            type: "runner.event",
            sessionId: SESSION_ID,
            payload: { eventType: ev.type, eventPayload: ev.payload },
          }),
        );
        await sleep(200);
      }

      // Simulate completion
      await sleep(500);
      ws.send(
        JSON.stringify({
          type: "runner.complete",
          sessionId: SESSION_ID,
          payload: {
            summary: `Completed task: ${task}`,
            diff: "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,5 @@\n+// Fixed by Hermes\n+console.log('hello');\n",
            changedFiles: ["src/index.ts"],
            testResult: { passed: true, total: 3, failed: 0, output: "3 tests passed" },
          },
        }),
      );

      console.log("[fake-runner] Task completed, sent artifacts");
      break;
    }

    case "pr.create": {
      await sleep(300);
      // Simulate PR creation
      ws.send(
        JSON.stringify({
          type: "runner.event",
          sessionId: SESSION_ID,
          payload: {
            eventType: "pr.created",
            eventPayload: { url: "https://github.com/test/repo/pull/1" },
          },
        }),
      );

      ws.send(
        JSON.stringify({
          type: "runner.complete",
          sessionId: SESSION_ID,
          payload: { prUrl: "https://github.com/test/repo/pull/1" },
        }),
      );

      console.log("[fake-runner] PR created (simulated)");
      break;
    }

    case "session.shutdown": {
      console.log("[fake-runner] Shutdown received, closing");
      if (heartbeat) clearInterval(heartbeat);
      ws.close(1000, "shutdown");
      process.exit(0);
      break;
    }

    case "approval.grant":
      console.log("[fake-runner] Approval granted");
      break;
    case "approval.deny":
      console.log("[fake-runner] Approval denied");
      break;
  }
});

ws.on("close", (code: number, reason: Buffer) => {
  console.log(`[fake-runner] WS closed: ${code} ${reason.toString()}`);
  if (heartbeat) clearInterval(heartbeat);
});

ws.on("error", (err: Error) => {
  console.error("[fake-runner] WS error:", err.message);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
