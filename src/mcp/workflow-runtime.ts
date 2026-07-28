import { getRun, invoke } from "@flue/runtime";

export type WorkflowRun = {
  runId: string;
  workflowName: string;
  status: "active" | "completed" | "errored";
  result?: unknown;
  error?: unknown;
};

/**
 * The only adapter boundary for Flue lifecycle calls.
 *
 * Keeping this seam separate from MCP handlers lets runtime tests inject a
 * deterministic implementation and gives a future Flue upgrade one place to
 * adapt invoke/getRun semantics.
 */
export type WorkflowRuntime = {
  invoke: (workflow: unknown, request: { input: unknown }) => Promise<{ runId: string }>;
  getRun: (runId: string) => Promise<WorkflowRun | null>;
};

export const ambientWorkflowRuntime: WorkflowRuntime = {
  invoke: (workflow, request) => invoke(workflow as never, request as never),
  getRun,
};

export function resolveWorkflowRuntime(runtime?: WorkflowRuntime): WorkflowRuntime {
  return runtime ?? ambientWorkflowRuntime;
}
