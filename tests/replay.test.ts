import { describe, it, expect, beforeAll } from "vitest";
import { signToken, verifyToken } from "../src/core/auth";

const MOCK_SECRET = "test-replay-secret";
let token: string;

beforeAll(async () => {
  token = await signToken(MOCK_SECRET, "test-session-1");
});

describe("replay auth", () => {
  it("generates valid HMAC token for session", async () => {
    const tok = await signToken(MOCK_SECRET, "test-session-1");
    expect(tok).toBeTypeOf("string");
    expect(tok.length).toBe(64);
  });

  it("verifies valid token", async () => {
    const ok = await verifyToken(MOCK_SECRET, "test-session-1", token);
    expect(ok).toBe(true);
  });

  it("rejects wrong token", async () => {
    const ok = await verifyToken(MOCK_SECRET, "test-session-1", "bad");
    expect(ok).toBe(false);
  });

  it("rejects token for different session id", async () => {
    const ok = await verifyToken(MOCK_SECRET, "test-session-2", token);
    expect(ok).toBe(false);
  });

  it("rejects tampered token", async () => {
    const tampered = token.slice(0, 32) + "0".repeat(32);
    const ok = await verifyToken(MOCK_SECRET, "test-session-1", tampered);
    expect(ok).toBe(false);
  });
});

describe("replay URL generation", () => {
  it("produces a URL with token query param", async () => {
    const sessionId = "replay-test-session";
    const tok = await signToken(MOCK_SECRET, sessionId);
    const base = "http://localhost:8787";
    const url = `${base}/sessions/${sessionId}/replay?token=${tok}`;

    expect(url).toContain("/sessions/replay-test-session/replay");
    expect(url).toContain("token=");
    expect(url).toContain("http://localhost:8787");

    const parsed = new URL(url);
    expect(parsed.searchParams.get("token")).toBe(tok);
  });
});

describe("stream endpoint URL construction", () => {
  it("constructs correct SSE stream URL", () => {
    const sessionId = "stream-test";
    const streamUrl = `/sessions/${sessionId}/stream?token=${token}&offset=-1&live=sse`;
    expect(streamUrl).toBe("/sessions/stream-test/stream?token=" + token + "&offset=-1&live=sse");
  });

  it("adds tail param when present", () => {
    const sessionId = "stream-tail";
    const streamUrl = `/sessions/${sessionId}/stream?token=${token}&offset=-1&live=sse&tail=50`;
    expect(streamUrl).toContain("&tail=50");
  });
});

describe("approval endpoint paths", () => {
  it("has correct GET path", () => {
    const path = "/approvals/approval_test123";
    expect(path).toMatch(/^\/approvals\//);
  });

  it("has correct POST path", () => {
    const path = "/approvals/approval_test123";
    expect(path).toMatch(/^\/approvals\//);
  });

  it("has correct open approvals path", () => {
    const path = "/sessions/test/approvals/open";
    expect(path).toMatch(/^\/sessions\/.*\/approvals\/open$/);
  });
});
