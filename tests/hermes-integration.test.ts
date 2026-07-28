import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");
const integrationRoot = path.join(root, "integrations", "hermes");

const nativeTools = [
  "spawn_coding_task",
  "get_coding_task",
  "respond_coding_approval",
  "cancel_coding_task",
  "start_pr_review",
  "start_sentry_triage",
  "get_specialist_workflow",
] as const;

const hermesTools = nativeTools.map((name) => `mcp__control_plan__${name}`);

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("Hermes integration contract", () => {
  const config = read("integrations/hermes/config.example.yaml");
  const delegation = read("integrations/hermes/skills/control-plan-delegation/SKILL.md");
  const prReview = read("integrations/hermes/skills/control-plan-pr-review/SKILL.md");
  const sentryTriage = read("integrations/hermes/skills/control-plan-sentry-triage/SKILL.md");
  const skills = [delegation, prReview, sentryTriage];

  it("keeps the config allowlist synchronized with the MCP tool surface", () => {
    for (const name of nativeTools) {
      expect(config).toContain(`        - ${name}`);
    }
    expect(config).toContain('Authorization: "Bearer ${CONTROL_PLAN_MCP_TOKEN}"');
    expect(config).toContain("timeout: 360");
    expect(config).toContain("connect_timeout: 60");
    expect(config).toContain("supports_parallel_tool_calls: false");
    expect(config).toContain("elicitation:\n      enabled: true\n      timeout: 300");
  });

  it("uses the Hermes v2026.7.20+ double-underscore tool convention", () => {
    const referencedTools = new Set(
      skills.flatMap((skill) => skill.match(/mcp__control_plan__[a-z_]+/g) ?? []),
    );
    expect([...referencedTools].toSorted()).toEqual(hermesTools.toSorted());
    for (const skill of skills) {
      expect(skill).not.toMatch(/\bmcp_control_plan_/);
    }
  });

  it("teaches coding lifecycle, approval, and terminal outcome handling", () => {
    expect(delegation).toContain("lifecycle");
    expect(delegation).toContain("pollAfterMs");
    expect(delegation).toContain("pass its `id` as `approvalId`");
    expect(delegation).toContain("capacity_exceeded");
    expect(delegation).toContain("idempotency_conflict");
    expect(delegation).toContain("completed + no_change");
    expect(delegation).toContain("failed + blocked");
    expect(delegation).toContain("`cancelled` is terminal");
  });

  it("keeps specialist skills snapshot-only and publication-free", () => {
    expect(prReview).toContain("at most 200,000 characters");
    expect(prReview).toContain("verify `reviewedHeadSha`");
    expect(prReview).toContain("Never claim that this workflow posted");
    expect(sentryTriage).toContain("at most 150,000 characters");
    expect(sentryTriage).toContain("Distinguish evidence from inference");
    expect(sentryTriage).toContain("not authorization to create a coding task");
  });

  it("ships all referenced integration artifacts", () => {
    expect(fs.existsSync(path.join(integrationRoot, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(integrationRoot, "config.example.yaml"))).toBe(true);
    for (const name of [
      "control-plan-delegation",
      "control-plan-pr-review",
      "control-plan-sentry-triage",
    ]) {
      expect(fs.existsSync(path.join(integrationRoot, "skills", name, "SKILL.md"))).toBe(true);
    }
  });
});
