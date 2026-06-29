import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "../src/core/auth";

describe("auth", () => {
  describe("signToken / verifyToken", () => {
    it("verifies a valid token", async () => {
      const secret = "test-secret-123";
      const sessionId = "session-abc";
      const token = await signToken(secret, sessionId);
      expect(token.length).toBe(64); // SHA-256 hex
      expect(await verifyToken(secret, sessionId, token)).toBe(true);
    });

    it("rejects invalid token", async () => {
      const secret = "test-secret-123";
      const sessionId = "session-abc";
      expect(await verifyToken(secret, sessionId, "bad-token")).toBe(false);
    });

    it("rejects token for different session", async () => {
      const secret = "test-secret-123";
      const token = await signToken(secret, "session-a");
      expect(await verifyToken(secret, "session-b", token)).toBe(false);
    });

    it("rejects token with different secret", async () => {
      const token = await signToken("secret-a", "session-1");
      expect(await verifyToken("secret-b", "session-1", token)).toBe(false);
    });

    it("rejects empty token", async () => {
      expect(await verifyToken("secret", "session", "")).toBe(false);
    });

    it("rejects empty secret", async () => {
      const token = await signToken("secret", "session");
      expect(await verifyToken("", "session", token)).toBe(false);
    });
  });
});
