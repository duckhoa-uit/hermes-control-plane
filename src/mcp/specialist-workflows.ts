import { createFlueClient } from "@flue/sdk";
import * as v from "valibot";
import { signScopedToken } from "../core/auth";
import { prReviewInput, sentryTriageInput } from "../core/specialist-workflow-contract";

export const specialistWorkflowNames = ["pr-review", "sentry-triage"] as const;
export type SpecialistWorkflowName = (typeof specialistWorkflowNames)[number];

const inputSchemas = {
  "pr-review": prReviewInput,
  "sentry-triage": sentryTriageInput,
} as const;

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
  options: { env: Env; origin: string; fetch: typeof fetch },
  workflow: SpecialistWorkflowName,
  input: unknown,
): Promise<{ runId: string }> {
  const parsed = v.safeParse(inputSchemas[workflow], input);
  if (!parsed.success) throw new Error(`Invalid ${workflow} workflow input`);
  const client = createFlueClient({
    baseUrl: options.origin,
    fetch: options.fetch,
    token: await internalWorkflowToken(options.env, workflow),
  });
  return client.workflows.invoke(workflow, { input: parsed.output });
}

export async function getSpecialistWorkflow(
  options: { env: Env; origin: string; fetch: typeof fetch },
  runId: string,
): Promise<SpecialistRunView | null> {
  let run: Awaited<ReturnType<ReturnType<typeof createFlueClient>["runs"]["get"]>> | undefined;
  for (const workflow of specialistWorkflowNames) {
    const client = createFlueClient({
      baseUrl: options.origin,
      fetch: options.fetch,
      token: await internalWorkflowToken(options.env, workflow),
    });
    try {
      run = await client.runs.get(runId);
      break;
    } catch {
      // The Flue run route is workflow-scoped; try the other allowlisted profile.
    }
  }
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

async function internalWorkflowToken(env: Env, workflow = "pr-review"): Promise<string> {
  return signScopedToken(
    env.CONTROL_PLAN_INTERNAL_SECRET || "",
    "workflow",
    workflow,
    5 * 60 * 1000,
  );
}
