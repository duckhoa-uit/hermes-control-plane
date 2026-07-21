import {
  defineAgent,
  defineWorkflow,
  registerProvider,
  type WorkflowRouteHandler,
  type WorkflowRunsHandler,
} from "@flue/runtime";
import { verifyScopedToken } from "../core/auth";
import { sentryTriageProfile } from "../agent/agent-profiles";
import {
  sentryTriageInput as input,
  sentryTriageOutput as output,
} from "../core/specialist-workflow-contract";

const agent = defineAgent<Env>(({ env }) => {
  if (env.ZAI_API_KEY) registerProvider("zai", { apiKey: env.ZAI_API_KEY });
  return {
    profile: sentryTriageProfile,
    model: env.LLM_MODEL || "anthropic/claude-sonnet-4-6",
  };
});

export default defineWorkflow({
  agent,
  input,
  output,
  async run({ harness, input: request }) {
    const response = await (await harness.session()).prompt(
      `Triage Sentry issue ${request.organization}/${request.project}/${request.issueId}.\n\nEvent:\n${request.event}\n\nTelemetry:\n${request.telemetry}\n\nCode context:\n${request.codeContext || "(none supplied)"}`,
      { result: output },
    );
    return response.data;
  },
});

export const route: WorkflowRouteHandler = (c, next) => authorize(c, next, "sentry-triage");
export const runs: WorkflowRunsHandler = (c, next) => authorize(c, next, "sentry-triage");

async function authorize(
  c: Parameters<WorkflowRouteHandler>[0],
  next: Parameters<WorkflowRouteHandler>[1],
  name: string,
) {
  const authorization = c.req.header("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const valid = await verifyScopedToken(
    (c.env as Env).CONTROL_PLAN_INTERNAL_SECRET || "",
    "workflow",
    name,
    token,
  );
  if (!valid) return c.json({ error: "unauthorized" }, 401);
  return next();
}
