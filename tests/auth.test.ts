import { describe, it, expect } from "vitest";
import { signScopedToken, verifyScopedToken } from "../src/core/auth";

describe("auth", () => {
  describe("scoped capability tokens", () => {
    it("binds a token to purpose and subject", async () => {
      const token = await signScopedToken("secret", "replay", "session", 60_000);
      expect(await verifyScopedToken("secret", "replay", "session", token)).toBe(true);
      expect(await verifyScopedToken("secret", "proxy", "session", token)).toBe(false);
      expect(await verifyScopedToken("secret", "replay", "other", token)).toBe(false);
    });

    it("rejects expired capabilities", async () => {
      const token = await signScopedToken("secret", "replay", "session", 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await verifyScopedToken("secret", "replay", "session", token)).toBe(false);
    });
  });
});
