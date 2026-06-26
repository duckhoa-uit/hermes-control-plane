// Tests for src/core/feature-flags.ts. We exercise:
//   - truthy / falsy boolean variants
//   - missing env vars
//   - percentageRollout boundary cases (0, 100, partial)
//   - rollout determinism (same key always returns the same answer)
//   - rollout distribution (~target % across many keys)
// ============================================================

import { describe, it, expect } from "vitest";
import {
  isFlagEnabled,
  percentageRollout,
  flagValue,
  type FlagSource,
} from "../src/core/feature-flags";

const env = (vars: Record<string, string>): FlagSource => vars;

describe("isFlagEnabled", () => {
  it("accepts 1 / true / on / yes (case-insensitive)", () => {
    for (const v of ["1", "true", "True", "TRUE", "on", "ON", "yes", "YES"]) {
      expect(isFlagEnabled("foo", env({ FF_FOO: v }))).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const v of ["", "0", "false", "off", "no", "random", " "]) {
      expect(isFlagEnabled("foo", env({ FF_FOO: v }))).toBe(false);
    }
  });

  it("returns false when the env var is missing", () => {
    expect(isFlagEnabled("missing_flag", env({}))).toBe(false);
  });

  it("uppercases the flag name to derive the env key", () => {
    expect(isFlagEnabled("autofix_review", env({ FF_AUTOFIX_REVIEW: "1" }))).toBe(true);
  });
});

describe("percentageRollout", () => {
  it("returns false when the env var is missing", () => {
    expect(percentageRollout("foo", "key", env({}))).toBe(false);
  });

  it("treats 0 (or negative) as fully closed", () => {
    expect(percentageRollout("foo", "k1", env({ FF_FOO_PCT: "0" }))).toBe(false);
    expect(percentageRollout("foo", "k1", env({ FF_FOO_PCT: "-10" }))).toBe(false);
  });

  it("treats >=100 as fully open", () => {
    expect(percentageRollout("foo", "k1", env({ FF_FOO_PCT: "100" }))).toBe(true);
    expect(percentageRollout("foo", "k1", env({ FF_FOO_PCT: "150" }))).toBe(true);
  });

  it("ignores non-numeric values", () => {
    expect(percentageRollout("foo", "k1", env({ FF_FOO_PCT: "fifty" }))).toBe(false);
  });

  it("is deterministic for a given (flag, key) pair", () => {
    const e = env({ FF_FOO_PCT: "50" });
    const a = percentageRollout("foo", "session-abc", e);
    const b = percentageRollout("foo", "session-abc", e);
    expect(a).toBe(b);
  });

  it("yields a different bucket for different flag names with the same key", () => {
    // With 1000 keys at 50% we expect the two flags' overlap to be ~50%,
    // not 100%. We assert at least a non-trivial mismatch to catch a
    // missing flag-name salt.
    const e = env({ FF_FOO_PCT: "50", FF_BAR_PCT: "50" });
    let differences = 0;
    for (let i = 0; i < 1000; i++) {
      const k = `key-${i}`;
      if (percentageRollout("foo", k, e) !== percentageRollout("bar", k, e)) {
        differences++;
      }
    }
    expect(differences).toBeGreaterThan(300);
    expect(differences).toBeLessThan(700);
  });

  it("approximately matches the target percentage over many keys", () => {
    const e = env({ FF_ROLLOUT_PCT: "25" });
    let on = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      if (percentageRollout("rollout", `id-${i}`, e)) on++;
    }
    const ratio = on / N;
    // Allow ±4 percentage-point slack — FNV-1a is not a cryptographic hash
    // but distributes well enough for rollout buckets.
    expect(ratio).toBeGreaterThan(0.21);
    expect(ratio).toBeLessThan(0.29);
  });
});

describe("flagValue", () => {
  it("returns the raw string when present", () => {
    expect(flagValue("model", env({ FF_MODEL: "glm-5.2" }))).toBe("glm-5.2");
  });
  it("returns undefined when absent", () => {
    expect(flagValue("model", env({}))).toBeUndefined();
  });
});
