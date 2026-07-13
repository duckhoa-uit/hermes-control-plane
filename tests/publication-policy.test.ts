import { describe, expect, it } from "vitest";
import {
  isSensitivePublicationPath,
  requiresPublicationApproval,
} from "../src/agent/publication-policy";

describe("publication policy", () => {
  it("allows normal task-branch pushes in policy mode", () => {
    expect(
      requiresPublicationApproval("policy", "git_push", {
        branch: "control-plan/task_123",
        changes: [{ path: "src/fix.ts" }],
      }),
    ).toBe(false);
  });

  it("gates force, sensitive, and non-task-branch pushes", () => {
    expect(
      requiresPublicationApproval("policy", "git_push", {
        branch: "control-plan/task_123",
        force: true,
        changes: [{ path: "src/fix.ts" }],
      }),
    ).toBe(true);
    expect(
      requiresPublicationApproval("policy", "git_push", {
        branch: "control-plan/task_123",
        changes: [{ path: ".github/workflows/release.yml" }],
      }),
    ).toBe(true);
    expect(
      requiresPublicationApproval("policy", "git_push", {
        branch: "main",
        changes: [{ path: "src/fix.ts" }],
      }),
    ).toBe(true);
  });

  it("only gates non-draft PR publication in policy mode", () => {
    expect(
      requiresPublicationApproval("policy", "create_pr", {
        branch: "control-plan/task_123",
        draft: true,
      }),
    ).toBe(false);
    expect(
      requiresPublicationApproval("policy", "create_pr", {
        branch: "control-plan/task_123",
        draft: false,
      }),
    ).toBe(true);
  });

  it("keeps manual mode conservative and identifies sensitive paths", () => {
    expect(
      requiresPublicationApproval("manual", "git_push", {
        branch: "control-plan/task_123",
        changes: [{ path: "src/fix.ts" }],
      }),
    ).toBe(true);
    expect(isSensitivePublicationPath("wrangler.jsonc")).toBe(true);
    expect(isSensitivePublicationPath("src/fix.ts")).toBe(false);
  });
});
