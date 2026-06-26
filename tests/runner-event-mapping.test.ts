// Verify that the pure OpenCode SSE -> Hermes event mapper produces the
// right runner.event payloads. The DO + WS hub depend on this contract
// after M4. Pure mapper lives in src/runner/event-mapper.ts so tests
// don't need to fake WebSocket / SDK / env vars.

import { describe, it, expect } from "vitest";
import {
  createEventMapper,
  type RunnerEventEmit,
  type OpencodeEvent,
} from "../src/runner/event-mapper";

function collect(): { emit: (e: RunnerEventEmit) => void; out: RunnerEventEmit[] } {
  const out: RunnerEventEmit[] = [];
  return { out, emit: (e) => out.push(e) };
}

describe("runner event mapping (OpenCode SSE -> Hermes events)", () => {
  it("maps message.part.delta (text) to agent.message.delta", () => {
    const { emit, out } = collect();
    const map = createEventMapper(emit);
    map({
      type: "message.part.delta",
      properties: { part: { type: "text" }, delta: "hello world" },
    });
    expect(out).toEqual([
      { eventType: "agent.message.delta", eventPayload: { text: "hello world" } },
    ]);
  });

  it("ignores message.part.delta without text part or without delta", () => {
    const { emit, out } = collect();
    const map = createEventMapper(emit);
    map({ type: "message.part.delta", properties: { part: { type: "tool" } } });
    map({ type: "message.part.delta", properties: { part: { type: "text" } } });
    map({ type: "message.part.delta", properties: { part: { type: "text" }, delta: "" } });
    expect(out).toHaveLength(0);
  });

  it("maps tool transitions running -> completed", () => {
    const { emit, out } = collect();
    const map = createEventMapper(emit);
    map({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          callID: "c1",
          tool: "edit",
          state: { status: "running", input: { file_path: "README.md" } },
        },
      },
    });
    map({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          callID: "c1",
          tool: "edit",
          state: { status: "completed", output: "ok", title: "edit README.md" },
        },
      },
    });
    expect(out.map((e) => e.eventType)).toEqual(["tool.started", "tool.completed"]);
    expect(out[0].eventPayload).toMatchObject({ callID: "c1", tool: "edit" });
    expect(out[1].eventPayload).toMatchObject({ callID: "c1", output: "ok" });
  });

  it("emits tool.started only once per callID even on repeated running updates", () => {
    const { emit, out } = collect();
    const map = createEventMapper(emit);
    const evt: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          callID: "c_dup",
          tool: "read",
          state: { status: "running", input: {} },
        },
      },
    };
    map(evt);
    map(evt);
    map(evt);
    expect(out.filter((e) => e.eventType === "tool.started")).toHaveLength(1);
  });

  it("maps tool error state to tool.completed with error payload", () => {
    const { emit, out } = collect();
    const map = createEventMapper(emit);
    map({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          callID: "c_err",
          tool: "edit",
          state: { status: "error", error: "permission denied" },
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].eventType).toBe("tool.completed");
    expect(out[0].eventPayload).toMatchObject({ callID: "c_err", error: "permission denied" });
  });

  it("maps file.edited to file.changed", () => {
    const { emit, out } = collect();
    const map = createEventMapper(emit);
    map({ type: "file.edited", properties: { file: "/home/user/repo/README.md" } });
    expect(out).toEqual([
      { eventType: "file.changed", eventPayload: { file: "/home/user/repo/README.md" } },
    ]);
  });

  it("maps permission.updated to approval.requested (M4: log only)", () => {
    const { emit, out } = collect();
    const map = createEventMapper(emit);
    map({
      type: "permission.updated",
      properties: {
        id: "perm_1",
        type: "edit",
        title: "write README.md",
        callID: "c4",
        metadata: { foo: "bar" },
      },
    });
    expect(out[0].eventType).toBe("approval.requested");
    expect(out[0].eventPayload).toMatchObject({
      id: "perm_1",
      title: "write README.md",
      callID: "c4",
    });
  });

  it("maps session.error to agent.error", () => {
    const { emit, out } = collect();
    const map = createEventMapper(emit);
    map({
      type: "session.error",
      properties: { error: { name: "ProviderAuthError", message: "bad key" } },
    });
    expect(out[0].eventType).toBe("agent.error");
    expect(out[0].eventPayload).toMatchObject({ error: "bad key", name: "ProviderAuthError" });
  });

  it("ignores session.idle (HTTP response is the authoritative terminal)", () => {
    const { emit, out } = collect();
    const map = createEventMapper(emit);
    map({ type: "session.idle", properties: { sessionID: "ses_x" } });
    expect(out).toHaveLength(0);
  });

  it("ignores noisy events (plugin.added, server.heartbeat, session.status, ...)", () => {
    const { emit, out } = collect();
    const map = createEventMapper(emit);
    for (const t of [
      "plugin.added",
      "catalog.updated",
      "server.heartbeat",
      "server.connected",
      "session.status",
      "session.updated",
      "session.diff",
      "message.updated",
      "file.watcher.updated",
      "session.next.agent.switched",
      "session.compacted",
      "session.next.model.switched",
      "reference.updated",
      "integration.updated",
    ]) {
      map({ type: t, properties: {} });
    }
    expect(out).toHaveLength(0);
  });

  it("emits agent.message.complete for cumulative text snapshots (no delta)", () => {
    const { emit, out } = collect();
    const map = createEventMapper(emit);
    map({ type: "message.part.updated", properties: { part: { type: "text", text: "done." } } });
    expect(out[0].eventType).toBe("agent.message.complete");
    expect(out[0].eventPayload).toEqual({ text: "done." });
  });
});
