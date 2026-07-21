import { getSandbox } from "@cloudflare/sandbox";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { CodingTaskRecord } from "../do/coding-task-do";
import {
  createFinalizeChangeAction,
  type ControlPlanFinalizeContext,
} from "./control-plan-finalize-action";
import { cloudflareSessionSandbox, getOrCreateSession } from "./cloudflare-session-sandbox";
import { ensureTaskWorkspace } from "./task-workspace";
import { withDefaultExecTimeout } from "./sandbox-timeout";
import instructions from "../agents/control-plan.md" with { type: "markdown" };
import codingTaskSkill from "../skills/control-plan-coding-task/SKILL.md" with { type: "skill" };
import { codingTaskProfile } from "./agent-profiles";

const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 15 * 60 * 1000;

export type ControlPlanAgentSetup = {
  env: Env;
  id: string;
  task: CodingTaskRecord | null;
  taskStub: ControlPlanFinalizeContext["taskStub"];
  taskRecord: () => Promise<CodingTaskRecord | null>;
};

/** Build the one coding harness shared by Workflow runs and Agent fallback. */
export async function createControlPlanAgentConfig(setup: ControlPlanAgentSetup) {
  const { env, id, task, taskStub, taskRecord } = setup;
  const sandboxId = `control-plan-${id}`;
  const sandboxSessionId = `flue-${sandboxId}`;
  const sandbox = () =>
    getSandbox(env.Sandbox, sandboxId, {
      // HITL approvals can pause a task for hours. The task DO destroys this
      // explicit session after a terminal transition.
      keepAlive: true,
      sleepAfter: "5m",
      transport: "rpc",
      // Avoid the deprecated provider-owned default session.
      enableDefaultSession: false,
      normalizeId: true,
    });
  const sandboxSession = () => getOrCreateSession(sandbox(), sandboxSessionId);
  const workspacePath = task
    ? await ensureTaskWorkspace(env, task, await sandboxSession(), DEFAULT_SANDBOX_EXEC_TIMEOUT_MS)
    : "/workspace";
  const approvalDO = env.APPROVAL_DO as unknown as DurableObjectNamespace;
  const finalizeChange = createFinalizeChangeAction({
    env,
    id,
    baseUrl: env.WORKER_URL || "",
    approvalDO,
    taskStub,
    taskRecord,
    sandboxSession,
    authorName: env.GITHUB_USER_LOGIN || "Control Plan",
    authorEmail:
      (env as Env & { GITHUB_USER_EMAIL?: string }).GITHUB_USER_EMAIL ||
      "control-plan-bot@users.noreply.github.com",
  });

  return {
    profile: codingTaskProfile,
    model: env.LLM_MODEL || "anthropic/claude-sonnet-4-6",
    instructions,
    skills: [codingTaskSkill],
    actions: [finalizeChange],
    tools: [],
    cwd: workspacePath,
    sandbox: withDefaultExecTimeout(
      cloudflareSessionSandbox(sandbox(), {
        cwd: "/workspace",
        sessionId: sandboxSessionId,
      }),
      DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
    ),
    durability: {
      maxAttempts: 10,
      timeoutMs: 2 * 60 * 60 * 1000,
    },
  };
}
