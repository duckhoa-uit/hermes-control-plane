import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { codingTaskModelResult, codingTaskWorkflowOutput } from "../src/core/coding-task-contract";

describe("coding task structured result contract", () => {
  it("accepts a published model result with verification evidence", () => {
    const parsed = v.safeParse(codingTaskModelResult, {
      outcome: "published",
      summary: "Implemented the requested change and published a draft PR.",
      verification: [{ command: "bun test", status: "passed" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the structural blocked result and lets the workflow guard enforce its reason", () => {
    const parsed = v.safeParse(codingTaskWorkflowOutput, {
      outcome: "blocked",
      summary: "The requested change could not be completed safely.",
      verification: [],
    });
    expect(parsed.success).toBe(true);
    // The workflow runtime guard rejects this case before returning the result.
  });

  it("does not treat a model-only publication claim as proof of publication", () => {
    const parsed = v.safeParse(codingTaskWorkflowOutput, {
      outcome: "published",
      summary: "Published.",
      verification: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.output.publication).toBeUndefined();
  });
});
