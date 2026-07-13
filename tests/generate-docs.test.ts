import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DOCS_DIR = path.resolve(__dirname, "../docs");

describe("auto-generated docs", () => {
  it("docs/ directory exists", () => {
    expect(fs.existsSync(DOCS_DIR)).toBe(true);
  });

  it("docs/api-reference.md exists", () => {
    const file = path.join(DOCS_DIR, "api-reference.md");
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("AUTO-GENERATED");
  });

  it("current deployment and architecture docs exist", () => {
    const file = path.join(DOCS_DIR, "DEPLOYMENT.md");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(DOCS_DIR, "ARCHITECTURE.md"))).toBe(true);
    expect(fs.existsSync(path.join(DOCS_DIR, "FLUE-MIGRATION-SPEC.md"))).toBe(false);
    expect(fs.existsSync(path.join(DOCS_DIR, "FLUE-BETA10-MIGRATION.md"))).toBe(false);
  });
});
