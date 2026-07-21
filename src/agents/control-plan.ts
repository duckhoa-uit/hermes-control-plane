import { defineAgent, registerProvider, type AgentRouteHandler } from "@flue/runtime";
import type { CodingTaskRecord } from "../do/coding-task-do";
import { createControlPlanAgentConfig } from "../agent/control-plan-agent-config";
import { verifyScopedToken } from "../core/auth";
import { taskIdFromSessionId } from "../mcp/task-utils";

export const route: AgentRouteHandler = async (c, next) => {
  const sessionId = c.req.param("id") || "";
  const authorization = c.req.header("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const valid = await verifyScopedToken(
    (c.env as Env).CONTROL_PLAN_INTERNAL_SECRET || "",
    "agent",
    sessionId,
    token,
  );
  if (!valid) return c.json({ error: "unauthorized" }, 401);
  return next();
};

export default defineAgent<Env>(async ({ id, env }) => {
  if (env.ZAI_API_KEY) registerProvider("zai", { apiKey: env.ZAI_API_KEY });
  const taskId = taskIdFromSessionId(id);
  const taskStub = taskId
    ? env.CONTROL_PLAN_TASK_DO.get(env.CONTROL_PLAN_TASK_DO.idFromName(taskId))
    : null;
  async function taskRecord(): Promise<CodingTaskRecord | null> {
    return taskStub ? taskStub.get() : null;
  }

  return createControlPlanAgentConfig({
    env,
    id,
    task: await taskRecord(),
    taskStub,
    taskRecord,
  });
});
