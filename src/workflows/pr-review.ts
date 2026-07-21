import {
  defineAgent,
  defineWorkflow,
  registerProvider,
  type WorkflowRouteHandler,
  type WorkflowRunsHandler,
} from "@flue/runtime";
import { verifyScopedToken } from "../core/auth";
import { prReviewProfile } from "../agent/agent-profiles";
import {
  prReviewInput as input,
  prReviewOutput as output,
} from "../core/specialist-workflow-contract";

const agent = defineAgent<Env>(({ env }) => {
  if (env.ZAI_API_KEY) registerProvider("zai", { apiKey: env.ZAI_API_KEY });
  return {
    profile: prReviewProfile,
    model: env.LLM_MODEL || "anthropic/claude-sonnet-4-6",
  };
});

export default defineWorkflow({
  agent,
  input,
  output,
  async run({ harness, input: request }) {
    const response = await (await harness.session()).prompt(
      `Review PR #${request.pullRequest} in ${request.repository}. Base SHA: ${request.baseSha}. Head SHA: ${request.headSha}.\n\nDiff:\n${request.diff}\n\nRepository context:\n${request.context || "(none supplied)"}`,
      { result: output },
    );
    if (response.data.reviewedHeadSha !== request.headSha) {
      throw new Error("PR review result does not identify the requested head SHA");
    }
    return response.data;
  },
});

export const route: WorkflowRouteHandler = (c, next) => authorize(c, next, "pr-review");
export const runs: WorkflowRunsHandler = (c, next) => authorize(c, next, "pr-review");

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
