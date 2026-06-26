// Smoke tests for scripts/generate-docs.ts.
//
// The generator's output ships with the repo, so its quality is already
// reviewed by humans. These tests guard the extractors against a
// regression that would silently produce empty / wrong tables.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();

describe("auto-generated docs", () => {
  it("docs/api-reference.md exists and contains both services", () => {
    const p = join(REPO, "docs/api-reference.md");
    expect(existsSync(p)).toBe(true);
    const s = readFileSync(p, "utf8");
    expect(s).toContain("## Worker (Cloudflare)");
    expect(s).toContain("## Launcher (Bun sidecar)");
    // At least one expected route should appear (drives the extractor).
    expect(s).toMatch(/\/health/);
    expect(s).toMatch(/\/sessions/);
    expect(s).toMatch(/\/webhooks\/github/);
  });

  it("docs/events-reference.md exists and lists known event/state types", () => {
    const p = join(REPO, "docs/events-reference.md");
    expect(existsSync(p)).toBe(true);
    const s = readFileSync(p, "utf8");
    expect(s).toContain("## `SessionStatus`");
    expect(s).toContain("## `HermesEventType`");
    expect(s).toContain("## `RunnerMessageType`");
    expect(s).toContain("`session.created`");
    expect(s).toContain("`runner.connected`");
    expect(s).toContain("`provisioning`");
  });

  it("docs/state-machine.mmd is a valid Mermaid stateDiagram-v2", () => {
    const p = join(REPO, "docs/state-machine.mmd");
    expect(existsSync(p)).toBe(true);
    const s = readFileSync(p, "utf8");
    expect(s.startsWith("%%{init")).toBe(true);
    expect(s).toContain("stateDiagram-v2");
    // Canonical edges we hard-code in the generator.
    expect(s).toContain("[*] --> created");
    expect(s).toContain("created --> provisioning");
    expect(s).toContain("review_ready --> creating_pr");
  });

  it("each generated file has the AUTO-GENERATED header", () => {
    for (const f of ["docs/api-reference.md", "docs/events-reference.md"]) {
      const s = readFileSync(join(REPO, f), "utf8");
      expect(s).toContain("AUTO-GENERATED FILE");
      expect(s).toContain("bun run docs:gen");
    }
    const mmd = readFileSync(join(REPO, "docs/state-machine.mmd"), "utf8");
    expect(mmd).toContain("Auto-generated");
  });
});
