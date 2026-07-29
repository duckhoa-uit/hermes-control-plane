import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as v from "valibot";
import { signScopedToken } from "../core/auth";
import { GitHubApp, GitHubAppError } from "../agent/github-app";
import type { CodingTaskRecord } from "../do/coding-task-do";
import { codingTaskId, derivedIdempotencyKey, taskLifecycle, taskBranch } from "./task-utils";
import {
  codingTaskWorkflowOutput,
  type CodingTaskWorkflowOutput,
} from "../core/coding-task-contract";
import {
  getSpecialistWorkflow,
  startSpecialistWorkflow,
  type WorkflowRuntime,
} from "./specialist-workflows";
import { resolveWorkflowRuntime } from "./workflow-runtime";
import { createLogger } from "../core/logger";
import { withCustomSpan, type WorkerTracing } from "../core/tracing";

const logger = createLogger({ service: "control-plan.mcp" });

export type ControlPlanMcpOptions = {
  env: Env;
  origin: string;
  runtime?: WorkflowRuntime;
  tracing?: WorkerTracing;
  requestId?: string;
};

const taskStateSchema = z.enum([
  "created",
  "dispatching",
  "dispatched",
  "publishing",
  "completed",
  "failed",
  "cancellation_requested",
  "cancelled",
]);

const lifecycleSchema = z.object({
  terminal: z.boolean(),
  nextAction: z.enum(["poll", "respond_to_approval", "report"]),
  pollAfterMs: z.number().optional(),
});

const codingTaskToolOutputSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  repository: z.string(),
  baseBranch: z.string(),
  branch: z.string(),
  task: z.string(),
  state: taskStateSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  replayUrl: z.string(),
  summary: z.string().optional(),
  error: z.string().optional(),
  outcome: z.enum(["published", "no_change", "blocked"]).optional(),
  verification: z
    .array(
      z.object({
        command: z.string(),
        status: z.enum(["passed", "failed", "not_run"]),
        notes: z.string().optional(),
      }),
    )
    .optional(),
  blockedReason: z.string().optional(),
  result: z
    .object({
      branch: z.string(),
      commitSha: z.string().optional(),
      prUrl: z.string().optional(),
      prNumber: z.number().optional(),
    })
    .optional(),
  workflowRunId: z.string().optional(),
  publicationSessionId: z.string().optional(),
  publicationStartedAt: z.number().optional(),
  approvals: z.array(z.unknown()).optional(),
  cancellation: z.string().optional(),
  lifecycle: lifecycleSchema,
});

const specialistStartOutputSchema = z.object({
  runId: z.string(),
  workflow: z.enum(["pr-review", "sentry-triage"]),
  terminal: z.literal(false),
  nextAction: z.literal("poll"),
  pollAfterMs: z.number(),
});

const specialistPollOutputSchema = z.object({
  runId: z.string(),
  workflow: z.enum(["pr-review", "sentry-triage"]),
  status: z.enum(["active", "completed", "errored"]),
  terminal: z.boolean(),
  nextAction: z.enum(["poll", "report"]),
  pollAfterMs: z.number().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export function isAuthorizedMcpRequest(request: Request, env: Env): boolean {
  const token = env.CONTROL_PLAN_MCP_TOKEN;
  return Boolean(token) && request.headers.get("Authorization") === `Bearer ${token}`;
}

// oxlint-disable-next-line max-lines-per-function -- MCP tool registration is one public contract.
export async function createControlPlanMcpHandler(options: ControlPlanMcpOptions) {
  const { createMcpHandler } = await import("agents/mcp");
  const server = new McpServer(
    { name: "control-plan", version: "0.1.0" },
    {
      instructions: [
        "Control Plan exposes two async surfaces.",
        "Coding tasks: call spawn_coding_task once, save taskId, poll get_coding_task until lifecycle.terminal=true, resolve approvals with respond_coding_approval, and use cancel_coding_task only when cancellation is explicitly required.",
        "Specialist workflows: call start_pr_review or start_sentry_triage only after the caller has supplied the bounded snapshot, save runId, and poll get_specialist_workflow until terminal=true.",
        "A dispatched or active result is not completion. Do not create duplicate runs while the returned lifecycle is non-terminal.",
      ].join("\n"),
    },
  );

  server.registerTool(
    "spawn_coding_task",
    {
      description:
        "Start one policy-checked asynchronous implementation task for a GitHub repository. Use when the repository, self-contained task, and acceptance criteria are known. This creates or reuses a durable task and may later publish a task branch or PR after verification and approval; dispatch is not completion. Save taskId and poll get_coding_task. Reuse the same idempotencyKey for retries; do not use this for PR review, Sentry triage, or status-only requests.",
      title: "Start coding task",
      inputSchema: z.object({
        repository: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
          .describe("GitHub repository in owner/repo form; do not pass a URL."),
        task: z
          .string()
          .min(1)
          .max(8000)
          .describe(
            "Self-contained implementation prompt with acceptance criteria and relevant constraints.",
          ),
        baseBranch: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Optional base branch to inspect; omit to use the repository default branch."),
        idempotencyKey: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            "Optional stable issue/run ID. If omitted, Control Plan derives one from the task and base branch.",
          ),
      }),
      outputSchema: codingTaskToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ repository, task, baseBranch, idempotencyKey }) => {
      let authorization;
      try {
        authorization = await new GitHubApp(options.env).authorizeRepository(
          repository,
          baseBranch,
        );
      } catch (error) {
        const message =
          error instanceof GitHubAppError
            ? error.message
            : `Could not authorize GitHub repository ${repository}`;
        return toolError(message);
      }
      const resolvedBaseBranch = authorization.baseBranch;

      const resolvedIdempotencyKey =
        idempotencyKey ?? (await derivedIdempotencyKey(task, resolvedBaseBranch));
      const id = await codingTaskId(repository, resolvedIdempotencyKey);
      const stub = taskStub(options.env, id);
      const sessionId = `control-plan-${id}`;
      const branch = taskBranch(id);
      const replayUrl = await signedReplayUrl(options.env, options.origin, sessionId);
      const created = await stub.create({
        id,
        sessionId,
        repository,
        baseBranch: resolvedBaseBranch,
        branch,
        task,
        replayUrl,
      });

      if (!created.created && created.conflict) {
        return toolError(
          JSON.stringify({
            code: "idempotency_conflict",
            taskId: created.task.id,
            message: created.conflict,
          }),
        );
      }

      if (
        !created.created &&
        created.task.state !== "created" &&
        created.task.state !== "dispatching"
      ) {
        return taskToolResult(created.task);
      }

      const claim = await stub.claimDispatch();
      if (!claim.claimed) return taskToolResult(claim.task ?? created.task);

      const admission = admissionStub(options.env);
      const limit = parsePositiveInt(options.env.MAX_CONCURRENT_SESSIONS, 10);
      const slot = await withCustomSpan(
        options.tracing,
        "control_plan.admission.acquire",
        { "control_plan.task_id": id, "control_plan.limit": limit },
        () => admission.tryAcquire({ taskId: id, limit }),
      );
      if (!slot.admitted) {
        await stub.releaseDispatch();
        return toolError(
          JSON.stringify({
            code: "capacity_exceeded",
            retryable: true,
            retryAfterMs: slot.retryAfterMs,
            active: slot.active,
            limit,
            task: created.task,
          }),
        );
      }

      try {
        const run = await invokeCodingTaskWorkflow(
          options.runtime,
          {
            taskId: id,
            repository,
            baseBranch: resolvedBaseBranch,
            branch,
            task,
            requestId: options.requestId,
          },
          options.tracing,
        );
        await stub.bindWorkflowRun(run.runId);
        const admitted = await stub.markDispatched();
        return taskToolResult(admitted ?? created.task);
      } catch (error) {
        const failed = await stub.markFailed(String(error));
        return toolError(failed?.error || "Flue dispatch failed");
      }
    },
  );

  server.registerTool(
    "get_coding_task",
    {
      description:
        "Reconcile one durable coding task and return its state, replay URL, approvals, verification, and publication result. Use with a taskId returned by spawn_coding_task. Follow lifecycle.nextAction and pollAfterMs rather than inferring completion from state names. If approvals is non-empty, pass the selected approval.id as approvalId to respond_coding_approval and then poll again. Do not spawn a duplicate while lifecycle.terminal is false.",
      title: "Get coding task status",
      inputSchema: z.object({
        taskId: z
          .string()
          .regex(/^task_[a-f0-9]{32}$/)
          .describe("Task ID returned by spawn_coding_task; do not use a Flue workflow runId."),
      }),
      outputSchema: codingTaskToolOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId }) => {
      const task = await refreshTask(taskId, options);
      if (!task) return toolError(`Coding task ${taskId} was not found.`);
      const approvals = await openApprovals(task.sessionId, options);
      return taskToolResult(task, { approvals });
    },
  );

  server.registerTool(
    "respond_coding_approval",
    {
      description:
        "Resolve one pending Control Plan publication approval for a coding task. Use only when get_coding_task returns a pending approval; pass approval.id as approvalId. A non-deny decision is only a request and must be confirmed through native Hermes form-mode elicitation; an accepted request resolves this one approval as once, while deny resolves immediately. After this tool returns, poll get_coding_task again because approval does not make the task terminal.",
      title: "Respond to coding approval",
      inputSchema: z.object({
        taskId: z
          .string()
          .regex(/^task_[a-f0-9]{32}$/)
          .describe("Task ID that owns the pending approval."),
        approvalId: z
          .string()
          .min(1)
          .max(255)
          .describe("Approval ID from the task's current approvals list."),
        decision: z
          .enum(["once", "session", "always", "deny"])
          .describe(
            "Requested decision hint. Non-deny values require native Hermes confirmation and an accepted request resolves only this approval.",
          ),
      }),
      outputSchema: z.object({
        taskId: z.string(),
        approval: z.unknown(),
        nextAction: z.literal("poll"),
        pollAfterMs: z.number(),
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ taskId, approvalId, decision }, extra) => {
      const task = await taskStub(options.env, taskId).get();
      if (!task) return toolError(`Coding task ${taskId} was not found.`);

      const approval = await approvalById(approvalId, options);
      if (!approval || approval.session_id !== task.sessionId || approval.status !== "pending") {
        return toolError(`Approval ${approvalId} is not pending for coding task ${taskId}.`);
      }
      let resolvedDecision = decision;
      if (decision !== "deny") {
        let elicitation;
        try {
          elicitation = await extra.sendRequest(
            {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: approvalMessage(approval),
                requestedSchema: {
                  type: "object",
                  properties: {
                    confirm: {
                      type: "boolean",
                      title: "Approve this operation",
                      description:
                        "The Control Plan will perform the described GitHub publication.",
                    },
                  },
                  required: ["confirm"],
                },
              },
            },
            ElicitResultSchema,
          );
        } catch (error) {
          return toolError(
            `Hermes gateway did not complete native approval elicitation: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        resolvedDecision = elicitation.action === "accept" ? "once" : "deny";
      }
      const resolved = await resolveApproval(approvalId, resolvedDecision, options);
      return toolResult({
        taskId,
        approval: resolved,
        nextAction: "poll",
        pollAfterMs: 15_000,
      });
    },
  );

  registerCodingCancellationTool(server, options);

  registerSpecialistWorkflowTools(server, options);

  return createMcpHandler(server, { route: "/mcp", enableJsonResponse: false });
}

function registerCodingCancellationTool(server: McpServer, options: ControlPlanMcpOptions): void {
  server.registerTool(
    "cancel_coding_task",
    {
      description:
        "Request cancellation of a non-terminal coding task and block later GitHub publication. Use only when cancellation is explicitly required or the operator timeout is reached. cancellation_requested is not completion; poll get_coding_task until cancelled, or report that publication is already in progress. Do not use this as a substitute for normal polling.",
      title: "Cancel coding task",
      inputSchema: z.object({
        taskId: z
          .string()
          .regex(/^task_[a-f0-9]{32}$/)
          .describe("Task ID returned by spawn_coding_task."),
      }),
      outputSchema: codingTaskToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ taskId }) => {
      const task = await taskStub(options.env, taskId).requestCancellation();
      if (!task) return toolError(`Coding task ${taskId} was not found.`);
      if (task.state === "publishing") {
        return taskToolResult(task, { cancellation: "publication_in_progress" });
      }
      if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") {
        return taskToolResult(task, { cancellation: "already_terminal" });
      }
      const cancelled =
        (await taskStub(options.env, taskId).markCancelled("Workflow cancellation requested")) ??
        task;
      return taskToolResult(cancelled, {
        cancellation: "requested_and_sandbox_destroyed",
      });
    },
  );
}

export function registerSpecialistWorkflowTools(
  server: McpServer,
  options: ControlPlanMcpOptions,
): void {
  server.registerTool(
    "start_pr_review",
    {
      description:
        "Start an asynchronous PR review Workflow from a caller-supplied bounded diff snapshot. Use only when the complete diff, repository, PR number, and base/head SHAs are already available; this tool does not fetch GitHub. Save runId and poll get_specialist_workflow. The workflow is read-only with respect to GitHub: it never comments, approves, pushes, creates a PR, or edits files.",
      title: "Start PR review",
      inputSchema: z.object({
        repository: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
          .describe("GitHub repository in owner/repo form for the supplied snapshot."),
        pullRequest: z
          .number()
          .int()
          .positive()
          .describe("Pull request number represented by the supplied diff."),
        baseSha: z.string().min(7).max(64).describe("Base commit SHA used to generate the diff."),
        headSha: z
          .string()
          .min(7)
          .max(64)
          .describe("Head commit SHA being reviewed; the result must echo this SHA."),
        diff: z
          .string()
          .min(1)
          .max(200_000)
          .describe(
            "Complete bounded unified diff. Fetch and truncate it before calling this tool.",
          ),
        context: z
          .string()
          .max(50_000)
          .optional()
          .describe(
            "Optional bounded repository/PR context; do not include credentials or unrelated secrets.",
          ),
      }),
      outputSchema: specialistStartOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const run = await startSpecialistWorkflow(options, "pr-review", input);
        return toolResult({
          runId: run.runId,
          workflow: "pr-review",
          terminal: false,
          nextAction: "poll",
          pollAfterMs: 5_000,
        });
      } catch (error) {
        return toolError(`Could not start PR review: ${errorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "start_sentry_triage",
    {
      description:
        "Start an asynchronous Sentry triage Workflow from a caller-supplied bounded issue/event snapshot. Use only when organization, project, issue ID, event, and telemetry are already available; this tool does not query Sentry. Save runId and poll get_specialist_workflow. The workflow never modifies Sentry, edits a repository, or publishes code.",
      title: "Start Sentry triage",
      inputSchema: z.object({
        organization: z
          .string()
          .min(1)
          .max(255)
          .describe("Sentry organization slug for the supplied snapshot."),
        project: z
          .string()
          .min(1)
          .max(255)
          .describe("Sentry project slug for the supplied snapshot."),
        issueId: z
          .string()
          .min(1)
          .max(255)
          .describe("Sentry issue short ID represented by the event."),
        event: z
          .string()
          .min(1)
          .max(100_000)
          .describe("Bounded event/error payload; fetch it before calling this tool."),
        telemetry: z
          .string()
          .min(1)
          .max(150_000)
          .describe("Bounded logs, traces, release, frequency, and environment telemetry."),
        codeContext: z
          .string()
          .max(100_000)
          .optional()
          .describe(
            "Optional bounded relevant code context; do not include credentials or unrelated files.",
          ),
      }),
      outputSchema: specialistStartOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const run = await startSpecialistWorkflow(options, "sentry-triage", input);
        return toolResult({
          runId: run.runId,
          workflow: "sentry-triage",
          terminal: false,
          nextAction: "poll",
          pollAfterMs: 5_000,
        });
      } catch (error) {
        return toolError(`Could not start Sentry triage: ${errorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "get_specialist_workflow",
    {
      description:
        "Poll a PR review or Sentry triage Workflow by a runId returned from start_pr_review or start_sentry_triage. Coding-task runs are not readable here. Poll while terminal=false, then report the structured result or error; do not restart a run because it is still active.",
      title: "Get specialist workflow",
      inputSchema: z.object({
        runId: z
          .string()
          .min(1)
          .max(255)
          .describe("Workflow runId returned by a specialist start tool."),
      }),
      outputSchema: specialistPollOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ runId }) => {
      try {
        const run = await getSpecialistWorkflow(options, runId);
        if (!run) return toolError(`Specialist workflow ${runId} was not found.`);
        return toolResult(run);
      } catch (error) {
        return toolError(`Could not read specialist workflow: ${errorMessage(error)}`);
      }
    },
  );
}

function approvalMessage(approval: any): string {
  const payload = approval.payload && typeof approval.payload === "object" ? approval.payload : {};
  const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const details = [
    `type=${approval.type}`,
    approval.title,
    metadata.repository ? `repository=${metadata.repository}` : "",
    metadata.branch ? `branch=${metadata.branch}` : "",
    metadata.changes ? `files=${metadata.changes}` : "",
    Array.isArray(metadata.paths) && metadata.paths.length > 0
      ? `paths=${metadata.paths.join(", ")}`
      : "",
    metadata.manifestHash ? `manifest=${String(metadata.manifestHash).slice(0, 12)}` : "",
  ].filter(Boolean);
  return `Control Plan approval required: ${details.join("; ")}. Review the task and approve only if this publication is expected.`;
}

function taskStub(env: Env, taskId: string) {
  return env.CONTROL_PLAN_TASK_DO.get(env.CONTROL_PLAN_TASK_DO.idFromName(taskId));
}

function admissionStub(env: Env) {
  return env.CONTROL_PLAN_ADMISSION_DO.get(env.CONTROL_PLAN_ADMISSION_DO.idFromName("global"));
}

async function refreshTask(
  taskId: string,
  options: ControlPlanMcpOptions,
): Promise<CodingTaskRecord | null> {
  const stub = taskStub(options.env, taskId);
  const task = await stub.get();
  if (task?.workflowRunId) {
    return refreshWorkflowTask(task, options);
  }
  return task;
}

async function refreshWorkflowTask(
  task: CodingTaskRecord,
  options: ControlPlanMcpOptions,
): Promise<CodingTaskRecord> {
  if (
    !task.workflowRunId ||
    task.state === "completed" ||
    task.state === "failed" ||
    task.state === "cancelled"
  ) {
    return task;
  }
  try {
    const run = await withCustomSpan(
      options.tracing,
      "control_plan.flue.get_run",
      { "control_plan.task_id": task.id, "control_plan.run_id": task.workflowRunId },
      () => resolveWorkflowRuntime(options.runtime).getRun(task.workflowRunId!),
    );
    if (!run) return task;
    if (run.status === "active") return task;
    if (task.state === "cancellation_requested") {
      return (
        (await taskStub(options.env, task.id).markCancelled(workflowSummary(run.error))) ?? task
      );
    }
    if (run.status === "completed") {
      const output = parseWorkflowOutput(run.result);
      if (!output) {
        return (
          (await taskStub(options.env, task.id).markFailed(
            "Workflow completed without a validated coding-task result",
          )) ?? task
        );
      }
      if (output.outcome === "published" && !task.result) {
        return (
          (await taskStub(options.env, task.id).markFailed(
            "Workflow claimed publication without a durable finalize_change result",
          )) ?? task
        );
      }
      return (await taskStub(options.env, task.id).settleWorkflow(output)) ?? task;
    }
    if (task.result) {
      return (
        (await taskStub(options.env, task.id).markTerminal(
          "completed",
          `Publication completed; Flue workflow ended with an error: ${workflowSummary(run.error) || "unknown error"}`,
        )) ?? task
      );
    }
    return (
      (await taskStub(options.env, task.id).markTerminal("failed", workflowSummary(run.error))) ??
      task
    );
  } catch (error) {
    logger.error("workflow reconciliation failed", {
      event: "task.workflow.reconciliation_failed",
      taskId: task.id,
      workflowRunId: task.workflowRunId,
      requestId: options.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return task;
  }
}

async function openApprovals(
  sessionId: string,
  options: ControlPlanMcpOptions,
): Promise<unknown[]> {
  const stub = options.env.APPROVAL_DO.get(options.env.APPROVAL_DO.idFromName("approvals"));
  const response = await stub.fetch(
    new Request(`${options.origin}/list-open?session_id=${encodeURIComponent(sessionId)}`),
  );
  if (!response.ok) return [];
  return normalizeOpenApprovals(await response.json().catch(() => ({})));
}

export function normalizeOpenApprovals(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const approvals = (value as { approvals?: unknown }).approvals;
  return Array.isArray(approvals) ? approvals : [];
}

async function approvalById(id: string, options: ControlPlanMcpOptions): Promise<any> {
  const stub = options.env.APPROVAL_DO.get(options.env.APPROVAL_DO.idFromName("approvals"));
  const response = await stub.fetch(
    new Request(`${options.origin}/get?id=${encodeURIComponent(id)}`),
  );
  return response.ok ? response.json() : null;
}

async function resolveApproval(
  id: string,
  decision: string,
  options: ControlPlanMcpOptions,
): Promise<unknown> {
  const stub = options.env.APPROVAL_DO.get(options.env.APPROVAL_DO.idFromName("approvals"));
  const response = await stub.fetch(
    new Request(`${options.origin}/resolve`, {
      method: "POST",
      body: JSON.stringify({ id, decision, actor: "hermes-agent" }),
    }),
  );
  return response.json();
}

async function signedReplayUrl(env: Env, origin: string, sessionId: string): Promise<string> {
  const token = await signScopedToken(
    env.CONTROL_PLAN_REPLAY_SECRET || "",
    "replay",
    sessionId,
    7 * 24 * 60 * 60 * 1000,
  );
  return `${origin}/replay/${sessionId}?token=${token}`;
}

function workflowSummary(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const summary = (value as { summary?: unknown }).summary;
    if (typeof summary === "string") return summary;
  }
  return value === undefined ? undefined : JSON.stringify(value);
}

export async function invokeCodingTaskWorkflow(
  runtime: WorkflowRuntime | undefined,
  input: {
    taskId: string;
    repository: string;
    baseBranch: string;
    branch: string;
    task: string;
    requestId?: string;
  },
  tracing?: WorkerTracing,
): Promise<{ runId: string }> {
  const workflow = (await import("../workflows/coding-task")).default;
  return withCustomSpan(
    tracing,
    "control_plan.flue.invoke",
    {
      "control_plan.task_id": input.taskId,
      "control_plan.repository": input.repository,
      "control_plan.workflow": "coding-task",
      "control_plan.request_id": input.requestId,
    },
    () => resolveWorkflowRuntime(runtime).invoke(workflow, { input }),
  );
}

function parseWorkflowOutput(value: unknown): CodingTaskWorkflowOutput | null {
  const parsed = v.safeParse(codingTaskWorkflowOutput, value);
  if (!parsed.success) return null;
  if (parsed.output.outcome === "blocked" && !parsed.output.blockedReason?.trim()) {
    return null;
  }
  return parsed.output;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toolResult(value: unknown) {
  const structuredContent =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function taskToolResult(task: CodingTaskRecord, extra: Record<string, unknown> = {}) {
  const approvals = Array.isArray(extra.approvals) ? extra.approvals : [];
  return toolResult({
    ...task,
    ...extra,
    lifecycle: taskLifecycle(task.state, approvals.length > 0),
  });
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
