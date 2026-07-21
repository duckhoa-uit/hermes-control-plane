import * as v from "valibot";

export const codingTaskVerification = v.object({
  command: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
  status: v.picklist(["passed", "failed", "not_run"] as const),
  notes: v.optional(v.pipe(v.string(), v.maxLength(2000))),
});

/** The only model-owned result fields. Publication is always application-owned. */
export const codingTaskModelResult = v.object({
  outcome: v.picklist(["published", "no_change", "blocked"] as const),
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
  verification: v.array(codingTaskVerification),
  blockedReason: v.optional(v.pipe(v.string(), v.maxLength(2000))),
});

export const codingTaskWorkflowOutput = v.object({
  outcome: v.picklist(["published", "no_change", "blocked"] as const),
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
  verification: v.array(codingTaskVerification),
  blockedReason: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  publication: v.optional(
    v.object({
      branch: v.string(),
      commitSha: v.optional(v.string()),
      prUrl: v.optional(v.string()),
      prNumber: v.optional(v.number()),
    }),
  ),
});

export type CodingTaskModelResult = v.InferOutput<typeof codingTaskModelResult>;
export type CodingTaskWorkflowOutput = v.InferOutput<typeof codingTaskWorkflowOutput>;
