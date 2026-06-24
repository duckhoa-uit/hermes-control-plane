import { describe, it, expect, beforeEach } from "vitest";
import { EventLog } from "../src/core/event-log";

describe("event-log", () => {
  let log: EventLog;

  beforeEach(() => {
    log = new EventLog();
  });

  it("starts empty", () => {
    expect(log.count()).toBe(0);
    expect(log.getLatestSeq()).toBe(-1);
  });

  it("appends events with incrementing seq", () => {
    const e1 = log.append("sess1", "session.created", "system");
    const e2 = log.append("sess1", "agent.started", "system");

    expect(e1.seq).toBe(0);
    expect(e2.seq).toBe(1);
    expect(log.count()).toBe(2);
    expect(log.getLatestSeq()).toBe(1);
  });

  it("stores payload correctly", () => {
    const e = log.append("sess1", "tool.started", "opencode", {
      tool: "bash",
      callId: "call_123",
    });

    expect(e.payload.tool).toBe("bash");
    expect(e.payload.callId).toBe("call_123");
    expect(e.sessionId).toBe("sess1");
  });

  it("generates unique event ids", () => {
    const e1 = log.append("sess1", "session.created", "system");
    const e2 = log.append("sess1", "agent.started", "system");

    expect(e1.id).not.toBe(e2.id);
  });

  it("getAll returns copy of all events", () => {
    log.append("sess1", "session.created", "system");
    log.append("sess1", "agent.started", "system");

    const all = log.getAll();
    expect(all.length).toBe(2);

    // Mutating returned array should not affect internal
    all.pop();
    expect(log.count()).toBe(2);
  });

  it("getSince returns events after seq", () => {
    log.append("sess1", "session.created", "system");  // seq 0
    log.append("sess1", "sandbox.provisioning", "system");  // seq 1
    log.append("sess1", "runner.connected", "runner");  // seq 2
    log.append("sess1", "agent.started", "system");  // seq 3

    const since1 = log.getSince(1);
    expect(since1.length).toBe(2);
    expect(since1[0].seq).toBe(2);
    expect(since1[1].seq).toBe(3);
  });

  it("getSince(-1) returns all events", () => {
    log.append("sess1", "session.created", "system");
    log.append("sess1", "agent.started", "system");

    const all = log.getSince(-1);
    expect(all.length).toBe(2);
  });

  it("getSince with seq beyond latest returns empty", () => {
    log.append("sess1", "session.created", "system");

    const result = log.getSince(100);
    expect(result.length).toBe(0);
  });

  it("clear resets the log", () => {
    log.append("sess1", "session.created", "system");
    log.clear();

    expect(log.count()).toBe(0);
    expect(log.getLatestSeq()).toBe(-1);
  });

  it("sets createdAt timestamp", () => {
    const before = Date.now();
    const e = log.append("sess1", "session.created", "system");
    const after = Date.now();

    expect(e.createdAt).toBeGreaterThanOrEqual(before);
    expect(e.createdAt).toBeLessThanOrEqual(after);
  });
});
