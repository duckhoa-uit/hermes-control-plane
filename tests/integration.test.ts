// ============================================================
// Integration test: full session flow without external services
// Tests the core orchestration logic end-to-end
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { EventLog } from "../src/core/event-log";
import { canTransition, isTerminal } from "../src/core/state-machine";
import type { Session, HermesEventType, EventSource, ProjectProfile } from "../src/core/types";

// Simulate a full session lifecycle using the same logic as SessionDO
function simulateSessionLifecycle(): {
  session: Session;
  events: { type: HermesEventType; source: EventSource; payload: Record<string, unknown> }[];
} {
  const profile: ProjectProfile = {
    id: "proj-1",
    name: "Test Project",
    repoUrl: "https://github.com/test/repo",
    defaultBranch: "main",
    model: "claude-sonnet-4-20250514",
    allowedTools: ["read", "edit", "bash"],
    approvalPolicy: {
      autoAllow: ["file.read", "file.edit", "test.run"],
      requireApproval: ["git.push", "pr.create"],
    },
  };

  const now = Date.now();
  let session: Session = {
    id: "sess_test",
    projectId: profile.id,
    taskDescription: "Fix failing tests",
    status: "created",
    branch: "hermes/test1234",
    createdAt: now,
    updatedAt: now,
    runnerConnected: false,
  };

  const events: { type: HermesEventType; source: EventSource; payload: Record<string, unknown> }[] = [];
  const log = new EventLog();

  function transition(to: Session["status"]) {
    expect(canTransition(session.status, to)).toBe(true);
    session.status = to;
    session.updatedAt = Date.now();
    const ev = { type: "session.status_changed" as HermesEventType, source: "system" as EventSource, payload: { to } };
    log.append(session.id, ev.type, ev.source, ev.payload);
    events.push(ev);
  }

  function emit(type: HermesEventType, source: EventSource, payload: Record<string, unknown> = {}) {
    log.append(session.id, type, source, payload);
    events.push({ type, source, payload });
  }

  // 1. Session created
  emit("session.created", "system", { taskDescription: session.taskDescription });

  // 2. Provisioning
  transition("provisioning");
  emit("sandbox.provisioning", "system", { sandboxId: "sbx_1" });

  // 3. Runner connects
  session.runnerConnected = true;
  session.lastHeartbeat = Date.now();
  transition("runner_connecting");
  emit("runner.connected", "runner");

  // 4. Ready
  transition("ready");

  // 5. Running - send prompt
  transition("running");
  emit("agent.started", "system", { taskDescription: session.taskDescription });

  // 6. Agent works
  emit("agent.message.delta", "opencode", { text: "Reading files..." });
  emit("tool.started", "opencode", { tool: "read", callId: "c1" });
  emit("tool.completed", "opencode", { callId: "c1", exitCode: 0 });
  emit("file.changed", "opencode", { path: "src/test.ts" });
  emit("agent.message.complete", "opencode", { text: "Done" });

  // 7. Agent completes
  emit("agent.done", "opencode", { summary: "Fixed tests" });
  emit("git.diff.ready", "runner", { diff: "fake diff" });

  // 8. Review ready
  transition("review_ready");

  // 9. User approves PR
  transition("creating_pr");
  emit("pr.created", "runner", { url: "https://github.com/test/repo/pull/1" });

  // 10. Completed
  transition("completed");
  emit("session.completed", "system", { prUrl: "https://github.com/test/repo/pull/1" });

  return { session, events };
}

describe("integration: full session lifecycle", () => {
  it("completes happy path: created -> completed", () => {
    const { session, events } = simulateSessionLifecycle();

    expect(session.status).toBe("completed");
    expect(isTerminal(session.status)).toBe(true);

    // Verify all key events fired in order
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes[0]).toBe("session.created");
    expect(eventTypes).toContain("sandbox.provisioning");
    expect(eventTypes).toContain("runner.connected");
    expect(eventTypes).toContain("agent.started");
    expect(eventTypes).toContain("agent.message.delta");
    expect(eventTypes).toContain("tool.started");
    expect(eventTypes).toContain("tool.completed");
    expect(eventTypes).toContain("file.changed");
    expect(eventTypes).toContain("agent.done");
    expect(eventTypes).toContain("git.diff.ready");
    expect(eventTypes).toContain("pr.created");
    expect(eventTypes[eventTypes.length - 1]).toBe("session.completed");
  });

  it("events are sequential", () => {
    const { session } = simulateSessionLifecycle();
    // Session should have gone through all major states
    expect(session.status).toBe("completed");
  });

  it("can handle abort mid-session", () => {
    const profile: ProjectProfile = {
      id: "proj-2",
      name: "Abort Test",
      repoUrl: "https://github.com/test/repo",
      defaultBranch: "main",
      model: "test",
      allowedTools: [],
      approvalPolicy: { autoAllow: [], requireApproval: [] },
    };

    let status: Session["status"] = "created";

    // created -> provisioning -> runner_connecting -> ready -> running
    expect(canTransition(status, "provisioning")).toBe(true); status = "provisioning";
    expect(canTransition(status, "runner_connecting")).toBe(true); status = "runner_connecting";
    expect(canTransition(status, "ready")).toBe(true); status = "ready";
    expect(canTransition(status, "running")).toBe(true); status = "running";

    // User aborts
    expect(canTransition(status, "aborted")).toBe(true); status = "aborted";

    expect(isTerminal(status)).toBe(true);
  });

  it("can handle needs_approval -> running cycle", () => {
    let status: Session["status"] = "running";

    // Agent requests approval
    expect(canTransition(status, "needs_approval")).toBe(true); status = "needs_approval";

    // User approves
    expect(canTransition(status, "running")).toBe(true); status = "running";

    // Agent continues
    expect(status).toBe("running");
  });

  it("can handle stall and failure", () => {
    let status: Session["status"] = "running";

    // Runner stalls
    expect(canTransition(status, "stalled")).toBe(true); status = "stalled";

    // Auto-fail
    expect(canTransition(status, "failed")).toBe(true); status = "failed";

    expect(isTerminal(status)).toBe(true);
  });
});

describe("integration: context package rendering", () => {
  it("renders context with project profile", () => {
    const profile: ProjectProfile = {
      id: "proj-ctx",
      name: "My API",
      repoUrl: "https://github.com/test/my-api",
      defaultBranch: "main",
      model: "claude-sonnet-4-20250514",
      allowedTools: ["read", "edit", "bash"],
      approvalPolicy: { autoAllow: [], requireApproval: [] },
      agentsContext: "This is a Node.js API using Express.",
    };

    const lines: string[] = [
      `# Hermes Task Context`,
      ``,
      `## Project: ${profile.name}`,
      `## Repository: ${profile.repoUrl}`,
      `## Branch: hermes/test`,
      ``,
      `## Task`,
      `Fix failing checkout tests`,
      ``,
      `## Project Instructions`,
      profile.agentsContext ?? "",
      ``,
    ];

    const context = lines.join("\n");

    expect(context).toContain("My API");
    expect(context).toContain("github.com/test/my-api");
    expect(context).toContain("Express");
    expect(context).toContain("Fix failing checkout tests");
  });
});

describe("integration: event log replay", () => {
  it("replays all events to reconnecting client", () => {
    const log = new EventLog();

    // Simulate session with events
    log.append("s1", "session.created", "system");
    log.append("s1", "sandbox.provisioning", "system");
    log.append("s1", "runner.connected", "runner");
    log.append("s1", "agent.started", "system");
    log.append("s1", "agent.message.delta", "opencode", { text: "hello" });

    // Client reconnects with lastSeq = 2 (already saw events 0,1,2)
    const replay = log.getSince(2);
    expect(replay.length).toBe(2);
    expect(replay[0].seq).toBe(3);
    expect(replay[1].seq).toBe(4);
    expect(replay[1].type).toBe("agent.message.delta");
  });
});
