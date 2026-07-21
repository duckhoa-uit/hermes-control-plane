import {
  defineAgent,
  defineWorkflow,
  getRun,
  registerProvider,
  type WorkflowRouteHandler,
  type WorkflowRunsHandler,
} from "@flue/runtime";
import * as v from "valibot";
import { verifyScopedToken } from "../core/auth";
import type { CodingTaskRecord } from "../do/coding-task-do";
import { createControlPlanAgentConfig } from "../agent/control-plan-agent-config";
import { codingTaskModelResult, codingTaskWorkflowOutput } from "../core/coding-task-contract";

const codingTaskInput = v.object({
  taskId: v.pipe(v.string(), v.regex(/^task_[a-f0-9]{32}$/)),
  repository: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  baseBranch: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  branch: v.pipe(v.string(), v.regex(/^control-plan\/[a-f0-9]{16}$/)),
  task: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
});

type CodingTaskInput = v.InferOutput<typeof codingTaskInput>;
type WorkflowContext = Parameters<WorkflowRouteHandler>[0];
type WorkflowNext = Parameters<WorkflowRouteHandler>[1];

function asCodingTaskInput(value: unknown): CodingTaskInput {
  const parsed = v.safeParse(codingTaskInput, value);
  if (!parsed.success) throw new Error("Workflow run input is not a valid coding task");
  return parsed.output;
}

const codingTaskAgent = defineAgent<Env>(async ({ id, env }) => {
  if (env.ZAI_API_KEY) registerProvider("zai", { apiKey: env.ZAI_API_KEY });
  const run = await getRun(id);
  if (!run) throw new Error(`Workflow run ${id} was not found`);
  const input = asCodingTaskInput(run.input);
  const taskStub = env.CONTROL_PLAN_TASK_DO.get(env.CONTROL_PLAN_TASK_DO.idFromName(input.taskId));
  const task = await taskStub.get();
  assertTaskInput(task, input);

  return createControlPlanAgentConfig({
    env,
    id: task.sessionId,
    task,
    taskStub,
    taskRecord: () => taskStub.get(),
  });
});

const codingTaskWorkflow = defineWorkflow({
  agent: codingTaskAgent,
  input: codingTaskInput,
  output: codingTaskWorkflowOutput,
  async run({ harness, input, log }) {
    const session = await harness.session();
    const response = await session.prompt(workflowPrompt(input), {
      result: codingTaskModelResult,
    });
    log.info("Control Plan workflow completed model turn", {
      outcome: response.data.outcome,
    });
    if (response.data.outcome === "blocked" && !response.data.blockedReason) {
      throw new Error("blocked coding workflow result must include blockedReason");
    }
    return response.data;
  },
});

export default codingTaskWorkflow;

export const route: WorkflowRouteHandler = async (c, next) => {
  return authorizeWorkflowRequest(c, next);
};

export const runs: WorkflowRunsHandler = async (c, next) => {
  return authorizeWorkflowRequest(c, next);
};

function assertTaskInput(
  task: CodingTaskRecord | null,
  input: CodingTaskInput,
): asserts task is CodingTaskRecord {
  if (!task) throw new Error(`Coding task ${input.taskId} was not found`);
  if (
    task.repository !== input.repository ||
    task.baseBranch !== input.baseBranch ||
    task.branch !== input.branch ||
    task.task !== input.task
  ) {
    throw new Error("Workflow input does not match the durable coding task");
  }
  if (
    task.state === "completed" ||
    task.state === "failed" ||
    task.state === "cancellation_requested" ||
    task.state === "cancelled"
  ) {
    throw new Error(`Coding task ${task.id} is already ${task.state}`);
  }
}

async function authorizeWorkflowRequest(c: WorkflowContext, next: WorkflowNext) {
  const authorization = c.req.header("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const valid = await verifyScopedToken(
    (c.env as Env).CONTROL_PLAN_INTERNAL_SECRET || "",
    "workflow",
    "coding-task",
    token,
  );
  if (!valid) return c.json({ error: "unauthorized" }, 401);
  return next();
}

function workflowPrompt(input: CodingTaskInput): string {
  const directory = input.repository.split("/")[1];
  return [
    `Work only on ${input.repository}, based on ${input.baseBranch}.`,
    `The task workspace is already provisioned at /workspace/${directory}; do not clone or change the repository remote.`,
    `The publication branch is fixed: ${input.branch}. Pass exactly this branch to finalize_change.`,
    "Read and follow the repository's AGENTS.md and relevant workspace instructions.",
    "Make the requested change, run the relevant checks, and call finalize_change only after the checks pass.",
    "Do not run git push, gh, or GitHub publication commands directly.",
    "Return a structured result with outcome published, no_change, or blocked. Use published only after finalize_change succeeds; use blocked with a concrete blockedReason when safe completion is impossible.",
    "Task:",
    input.task,
  ].join("\n\n");
}
