import * as v from "valibot";
import { prReviewInput, sentryTriageInput } from "../core/specialist-workflow-contract";
import { resolveWorkflowRuntime, type WorkflowRuntime } from "./workflow-runtime";
import { withCustomSpan, type WorkerTracing } from "../core/tracing";

export const specialistWorkflowNames = ["pr-review", "sentry-triage"] as const;
export type SpecialistWorkflowName = (typeof specialistWorkflowNames)[number];

const inputSchemas = {
  "pr-review": prReviewInput,
  "sentry-triage": sentryTriageInput,
} as const;

export type { WorkflowRuntime } from "./workflow-runtime";

export type SpecialistRunView = {
  runId: string;
  workflow: SpecialistWorkflowName;
  status: "active" | "completed" | "errored";
  terminal: boolean;
  nextAction: "poll" | "report";
  pollAfterMs?: number;
  result?: unknown;
  error?: unknown;
};

export function isSpecialistWorkflowName(value: string): value is SpecialistWorkflowName {
  return (specialistWorkflowNames as readonly string[]).includes(value);
}

export async function startSpecialistWorkflow(
  options: { runtime?: WorkflowRuntime; tracing?: WorkerTracing },
  workflow: SpecialistWorkflowName,
  input: unknown,
): Promise<{ runId: string }> {
  const parsed = v.safeParse(inputSchemas[workflow], input);
  if (!parsed.success) throw new Error(`Invalid ${workflow} workflow input`);
  return withCustomSpan(
    options.tracing,
    "control_plan.flue.invoke",
    { "control_plan.workflow": workflow },
    async () => {
      if (options.runtime) {
        return options.runtime.invoke({ workflow } as never, { input: parsed.output });
      }
      const definition =
        workflow === "pr-review"
          ? (await import("../workflows/pr-review")).default
          : (await import("../workflows/sentry-triage")).default;
      return resolveWorkflowRuntime().invoke(definition, { input: parsed.output });
    },
  );
}

export async function getSpecialistWorkflow(
  options: { runtime?: WorkflowRuntime; tracing?: WorkerTracing },
  runId: string,
): Promise<SpecialistRunView | null> {
  const run = await withCustomSpan(
    options.tracing,
    "control_plan.flue.get_run",
    { "control_plan.run_id": runId },
    () => resolveWorkflowRuntime(options.runtime).getRun(runId),
  );
  if (!run || !isSpecialistWorkflowName(run.workflowName)) return null;
  const terminal = run.status !== "active";
  return {
    runId: run.runId,
    workflow: run.workflowName,
    status: run.status,
    terminal,
    nextAction: terminal ? "report" : "poll",
    ...(terminal ? {} : { pollAfterMs: 5_000 }),
    ...(run.status === "completed" ? { result: run.result } : { error: run.error }),
  };
}
