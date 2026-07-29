import { describe, expect, it } from "vitest";
import {
  newTaskEventId,
  sanitizeTaskEventData,
  TASK_EVENT_SCHEMA_VERSION,
} from "../src/core/task-events";

describe("task event sanitization", () => {
  it("bounds payloads and redacts secrets before persistence", () => {
    const result = sanitizeTaskEventData({
      token: "sensitive-value",
      output: "x".repeat(5_000),
      nested: { level: { deeper: { tooDeep: { value: "hidden" } } } },
    });

    expect(result.redacted).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.data.token).toBe("[redacted]");
    expect(String(result.data.output)).toContain("[truncated]");
    expect(result.data.nested).toBeDefined();
  });

  it("creates opaque event IDs and exposes a schema version", () => {
    expect(newTaskEventId()).toMatch(/^evt_[a-f0-9]{32}$/);
    expect(TASK_EVENT_SCHEMA_VERSION).toBe(1);
  });
});
