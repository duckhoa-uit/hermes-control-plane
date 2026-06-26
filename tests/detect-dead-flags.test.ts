// Tests for scripts/detect-dead-flags.ts. We exercise the two pure
// functions the detector exposes (`extractCallSitesFromText` and
// `reconcile`) so the dead-flag CI gate is itself protected by tests.
// The filesystem walk + main() entry point are excluded from coverage on
// purpose — they're thin glue around the pure functions.

import { describe, it, expect } from "vitest";
import {
  extractCallSitesFromText,
  reconcile,
  type RegistryFlag,
  type CallSite,
} from "../scripts/detect-dead-flags";

const DAY = 1000 * 60 * 60 * 24;

const flag = (overrides: Partial<RegistryFlag> & { name: string }): RegistryFlag => ({
  kind: "boolean",
  owner: "@alice",
  createdAt: "2026-01-01",
  ...overrides,
});

describe("extractCallSitesFromText", () => {
  it("finds isFlagEnabled / percentageRollout / flagValue call sites", () => {
    const src = [
      `import { isFlagEnabled, percentageRollout, flagValue } from "@/core/feature-flags";`,
      ``,
      `if (isFlagEnabled("autofix_review_changes", env)) doThing();`,
      `const variant = flagValue("model", env);`,
      `if (percentageRollout("new_sandbox_image", sessionId, env)) other();`,
    ].join("\n");

    const sites = extractCallSitesFromText("src/example.ts", src);
    expect(sites).toEqual<CallSite[]>([
      { flag: "autofix_review_changes", file: "src/example.ts", line: 3 },
      { flag: "model", file: "src/example.ts", line: 4 },
      { flag: "new_sandbox_image", file: "src/example.ts", line: 5 },
    ]);
  });

  it("handles multiple call sites on the same line", () => {
    const src = `const a = isFlagEnabled("foo", env) || isFlagEnabled("bar", env);`;
    const sites = extractCallSitesFromText("src/x.ts", src);
    expect(sites.map((s) => s.flag)).toEqual(["foo", "bar"]);
    expect(sites.every((s) => s.line === 1)).toBe(true);
  });

  it("ignores look-alikes that aren't real call sites", () => {
    const src = [
      `// isFlagEnabled("commented_out", env)`,
      `const isFlagEnabledLike = 1;`,
      `function notIsFlagEnabled() {}`,
    ].join("\n");
    const sites = extractCallSitesFromText("src/x.ts", src);
    // The commented-out line still grep-matches — that's intentional; the
    // detector is a string scan, not a parser. It is the call site, just
    // disabled. Treating commented-out call sites as "absent" would create
    // a way to game the registry. So we assert the comment IS picked up.
    expect(sites).toEqual([{ flag: "commented_out", file: "src/x.ts", line: 1 }]);
  });

  it("rejects flag names not matching snake_case", () => {
    // The CALL_SITE_RE only captures lowercase snake_case names. A flag
    // accidentally written in camelCase / PascalCase won't be picked up —
    // which is fine because feature-flags.ts uppercases the name to derive
    // the env var, so a non-snake-case literal would also fail at runtime.
    const src = `if (isFlagEnabled("CamelCase", env)) {}`;
    const sites = extractCallSitesFromText("src/x.ts", src);
    expect(sites).toEqual([]);
  });
});

describe("reconcile", () => {
  const now = new Date("2026-06-27T00:00:00Z").getTime();

  it("reports an empty clean state", () => {
    const r = reconcile([], [], { now });
    expect(r.declaredButUnused).toEqual([]);
    expect(r.usedButUndeclared).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  it("flags declared-but-unused flags as dead", () => {
    const flags = [flag({ name: "kept", createdAt: "2026-06-01" })];
    const sites: CallSite[] = []; // no call sites at all
    const r = reconcile(flags, sites, { now });
    expect(r.declaredButUnused).toEqual([
      { name: "kept", owner: "@alice", createdAt: "2026-06-01" },
    ]);
    expect(r.stale).toEqual([]); // unused flags don't double-report as stale
  });

  it("flags used-but-undeclared flags and groups by name", () => {
    const sites: CallSite[] = [
      { flag: "unregistered", file: "src/a.ts", line: 10 },
      { flag: "unregistered", file: "src/b.ts", line: 20 },
      { flag: "also_new", file: "src/c.ts", line: 5 },
    ];
    const r = reconcile([], sites, { now });
    expect(r.usedButUndeclared).toHaveLength(2);
    const unregistered = r.usedButUndeclared.find((u) => u.name === "unregistered");
    expect(unregistered?.sites).toHaveLength(2);
    expect(r.usedButUndeclared.find((u) => u.name === "also_new")?.sites).toHaveLength(1);
  });

  it("flags stale flags (older than default 90 days) that still have call sites", () => {
    const flags = [
      flag({ name: "fresh", createdAt: "2026-05-01" }), // ~57d
      flag({ name: "stale", createdAt: "2026-01-01" }), // ~177d
    ];
    const sites: CallSite[] = [
      { flag: "fresh", file: "src/x.ts", line: 1 },
      { flag: "stale", file: "src/x.ts", line: 2 },
    ];
    const r = reconcile(flags, sites, { now, defaultMaxAgeDays: 90 });
    expect(r.stale.map((s) => s.name)).toEqual(["stale"]);
    expect(r.stale[0].ageDays).toBeGreaterThan(90);
    expect(r.stale[0].maxAgeDays).toBe(90);
  });

  it("honours per-flag maxAgeDays overrides", () => {
    // A 180-day flag is fine at 177d (under the 365-day override) but a
    // sibling using the default 90d window still trips the gate.
    const flags = [
      flag({ name: "long_runner", createdAt: "2026-01-01", maxAgeDays: 365 }),
      flag({ name: "default_window", createdAt: "2026-01-01" }),
    ];
    const sites: CallSite[] = [
      { flag: "long_runner", file: "src/x.ts", line: 1 },
      { flag: "default_window", file: "src/x.ts", line: 2 },
    ];
    const r = reconcile(flags, sites, { now, defaultMaxAgeDays: 90 });
    expect(r.stale.map((s) => s.name)).toEqual(["default_window"]);
  });

  it("never reports dead and stale for the same flag", () => {
    // A flag that is both unused AND old shows up under declaredButUnused
    // only — flagging it as stale too would be noisy double-counting.
    const flags = [flag({ name: "old_and_unused", createdAt: "2026-01-01" })];
    const r = reconcile(flags, [], { now, defaultMaxAgeDays: 90 });
    expect(r.declaredButUnused).toHaveLength(1);
    expect(r.stale).toHaveLength(0);
  });
});
