import { describe, it, expect } from "vitest";
import {
  generateId,
  generateSessionId,
  generateCommandId,
  generateRequestId,
  generateRunnerToken,
} from "../src/core/id";

describe("id generators", () => {
  it("generates unique sequential ids", () => {
    const id1 = generateId("test");
    const id2 = generateId("test");
    expect(id1).not.toBe(id2);
    expect(id1.startsWith("test_")).toBe(true);
  });

  it("generates session id with sess prefix", () => {
    const id = generateSessionId();
    expect(id.startsWith("sess_")).toBe(true);
  });

  it("generates command id with cmd prefix", () => {
    const id = generateCommandId();
    expect(id.startsWith("cmd_")).toBe(true);
  });

  it("generates request id with req prefix", () => {
    const id = generateRequestId();
    expect(id.startsWith("req_")).toBe(true);
  });

  it("generates 64-char hex runner token", () => {
    const token = generateRunnerToken();
    expect(token.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it("generates different runner tokens", () => {
    const t1 = generateRunnerToken();
    const t2 = generateRunnerToken();
    expect(t1).not.toBe(t2);
  });
});
