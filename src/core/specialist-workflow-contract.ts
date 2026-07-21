import * as v from "valibot";

export const prReviewInput = v.object({
  repository: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  pullRequest: v.pipe(v.number(), v.integer(), v.minValue(1)),
  baseSha: v.pipe(v.string(), v.minLength(7), v.maxLength(64)),
  headSha: v.pipe(v.string(), v.minLength(7), v.maxLength(64)),
  diff: v.pipe(v.string(), v.minLength(1), v.maxLength(200_000)),
  context: v.optional(v.pipe(v.string(), v.maxLength(50_000))),
});

export const prReviewOutput = v.object({
  verdict: v.picklist(["approve", "changes_requested", "comment"] as const),
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
  findings: v.array(
    v.object({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
      startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
      endLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
      severity: v.picklist(["critical", "high", "medium", "low"] as const),
      confidence: v.picklist(["high", "medium", "low"] as const),
      title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      body: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
    }),
  ),
  reviewedHeadSha: v.string(),
});

export const sentryTriageInput = v.object({
  organization: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  project: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  issueId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  event: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
  telemetry: v.pipe(v.string(), v.minLength(1), v.maxLength(150_000)),
  codeContext: v.optional(v.pipe(v.string(), v.maxLength(100_000))),
});

export const sentryTriageOutput = v.object({
  severity: v.picklist(["critical", "high", "medium", "low", "unknown"] as const),
  actionability: v.picklist(["high", "medium", "low", "unknown"] as const),
  rootCause: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
  evidence: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(3000))),
  nextAction: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  blockedReason: v.optional(v.pipe(v.string(), v.maxLength(2000))),
});

export type PrReviewInput = v.InferOutput<typeof prReviewInput>;
export type SentryTriageInput = v.InferOutput<typeof sentryTriageInput>;
