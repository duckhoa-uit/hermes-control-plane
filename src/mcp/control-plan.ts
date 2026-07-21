import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createFlueClient } from "@flue/sdk";
import { z } from "zod";
import * as v from "valibot";
import { signScopedToken } from "../core/auth";
import { GitHubApp, GitHubAppError } from "../agent/github-app";
import type { CodingTaskExecutionMode, CodingTaskRecord } from "../do/coding-task-do";
import {
  codingTaskId,
  derivedIdempotencyKey,
  taskLifecycle,
  taskStateFromHistory,
  taskBranch,
} from "./task-utils";
import {
  codingTaskWorkflowOutput,
  type CodingTaskWorkflowOutput,
} from "../core/coding-task-contract";
import { getSpecialistWorkflow, startSpecialistWorkflow } from "./specialist-workflows";

type InternalFetch = typeof fetch;

export type ControlPlanMcpOptions = {
  env: Env;
  origin: string;
  fetch: InternalFetch;
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
  executionMode: z.enum(["agent", "workflow"]).optional(),
  state: taskStateSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  replayUrl: z.string(),
  submissionId: z.string().optional(),
  streamOffset: z.string().optional(),
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
      const executionMode = configuredExecutionMode(options.env.CONTROL_PLAN_EXECUTION_MODE);
      const replayUrl = await signedReplayUrl(options.env, options.origin, sessionId);
      const created = await stub.create({
        id,
        sessionId,
        repository,
        baseBranch: resolvedBaseBranch,
        branch,
        task,
        replayUrl,
        executionMode,
      });
      const taskExecutionMode = created.task.executionMode ?? executionMode;

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
      const slot = await admission.tryAcquire({ taskId: id, limit });
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
        const client = createFlueClient({
          baseUrl: options.origin,
          fetch: options.fetch,
          token:
            taskExecutionMode === "workflow"
              ? await internalWorkflowToken(options.env)
              : await internalAgentToken(options.env, sessionId),
        });
        if (taskExecutionMode === "workflow") {
          const run = await client.workflows.invoke("coding-task", {
            input: {
              taskId: id,
              repository,
              baseBranch: resolvedBaseBranch,
              branch,
              task,
            },
          });
          await stub.bindWorkflowRun(run.runId);
          const admitted = await stub.markDispatched({
            submissionId: run.runId,
            streamOffset: "-1",
          });
          return taskToolResult(admitted ?? created.task);
        }
        const dispatch = await client.agents.send("control-plan", sessionId, {
          message: codingPrompt(repository, resolvedBaseBranch, branch, task),
        });
        const admitted = await stub.markDispatched({
          submissionId: dispatch.submissionId,
          streamOffset: dispatch.offset,
        });
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
        "Reconcile one durable coding task and return its state, replay URL, approvals, verification, and publication result. Use with a taskId returned by spawn_coding_task. dispatched, publishing, and cancellation_requested are active non-terminal states; poll every 10-20 seconds until completed, failed, or cancelled. If approvals is non-empty, call respond_coding_approval and then poll again. Do not spawn a duplicate while lifecycle.terminal is false.",
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
        "Resolve one pending Control Plan publication approval for a coding task. Use only when get_coding_task returns the matching approvalId. For once, session, or always, the decision is a request that must be confirmed through native Hermes elicitation; deny resolves immediately. After this tool returns, poll get_coding_task again because approval does not make the task terminal.",
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
            "Requested approval scope; non-deny values still require native Hermes confirmation.",
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
      if (task.executionMode === "workflow") {
        const cancelled =
          (await taskStub(options.env, taskId).markCancelled("Workflow cancellation requested")) ??
          task;
        return taskToolResult(cancelled, {
          cancellation: "requested_and_sandbox_destroyed",
        });
      }
      let abortRequested = false;
      try {
        const client = createFlueClient({
          baseUrl: options.origin,
          fetch: options.fetch,
          token: await internalAgentToken(options.env, task.sessionId),
        });
        const result = await client.agents.abort("control-plan", task.sessionId);
        abortRequested = result.aborted;
      } catch {
        // Durable task state remains cancellation_requested if transport abort is unavailable.
      }
      return taskToolResult(task, {
        cancellation: abortRequested ? "requested_and_aborted" : "requested",
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
  let task = await stub.get();
  if (task?.executionMode === "workflow" && task.workflowRunId) {
    return refreshWorkflowTask(task, options);
  }
  if (
    !task ||
    (task.state !== "dispatched" &&
      task.state !== "publishing" &&
      task.state !== "cancellation_requested") ||
    !task.streamOffset
  ) {
    return task;
  }

  const response = await options.fetch(
    new Request(`${options.origin}/agents/control-plan/${task.sessionId}?view=history`, {
      headers: {
        Authorization: `Bearer ${await internalAgentToken(options.env, task.sessionId)}`,
      },
    }),
  );
  if (!response.ok) return task;

  const history = (await response.json().catch(() => ({}))) as Parameters<
    typeof taskStateFromHistory
  >[0];
  const update = taskStateFromHistory(history, task.submissionId);
  if (update.offset && update.offset !== task.streamOffset) {
    task = (await stub.advanceStreamOffset(update.offset)) ?? task;
  }
  if (update.state === "aborted") return (await stub.markCancelled(update.summary)) ?? task;
  if (update.state === "completed" || update.state === "failed") {
    return (await stub.markTerminal(update.state, update.summary)) ?? task;
  }
  return task;
}

async function refreshWorkflowTask(
  task: CodingTaskRecord,
  options: ControlPlanMcpOptions,
): Promise<CodingTaskRecord> {
  if (!task.workflowRunId) return task;
  try {
    const client = createFlueClient({
      baseUrl: options.origin,
      fetch: options.fetch,
      token: await internalWorkflowToken(options.env),
    });
    const run = await client.runs.get(task.workflowRunId);
    if (run.status === "active") return task;
    if (task.state === "cancellation_requested") {
      return (
        (await taskStub(options.env, task.id).markCancelled(workflowSummary(run.error))) ?? task
      );
    }
    if (task.state === "cancelled") return task;
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
  } catch {
    return task;
  }
}

async function openApprovals(sessionId: string, options: ControlPlanMcpOptions): Promise<unknown> {
  const stub = options.env.APPROVAL_DO.get(options.env.APPROVAL_DO.idFromName("approvals"));
  const response = await stub.fetch(
    new Request(`${options.origin}/list-open?session_id=${encodeURIComponent(sessionId)}`),
  );
  return response.ok ? response.json() : [];
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

async function internalAgentToken(env: Env, sessionId: string): Promise<string> {
  return signScopedToken(env.CONTROL_PLAN_INTERNAL_SECRET || "", "agent", sessionId, 5 * 60 * 1000);
}

export async function internalWorkflowToken(
  env: Env,
  workflowName = "coding-task",
): Promise<string> {
  return signScopedToken(
    env.CONTROL_PLAN_INTERNAL_SECRET || "",
    "workflow",
    workflowName,
    5 * 60 * 1000,
  );
}

function configuredExecutionMode(value: string | undefined): CodingTaskExecutionMode {
  return value === "agent" ? "agent" : "workflow";
}

function workflowSummary(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const summary = (value as { summary?: unknown }).summary;
    if (typeof summary === "string") return summary;
  }
  return value === undefined ? undefined : JSON.stringify(value);
}

function parseWorkflowOutput(value: unknown): CodingTaskWorkflowOutput | null {
  const parsed = v.safeParse(codingTaskWorkflowOutput, value);
  if (!parsed.success) return null;
  if (parsed.output.outcome === "blocked" && !parsed.output.blockedReason?.trim()) {
    return null;
  }
  return parsed.output;
}

function codingPrompt(
  repository: string,
  baseBranch: string,
  branch: string,
  task: string,
): string {
  const directory = repository.split("/")[1];
  return [
    `Work only on https://github.com/${repository}.git, based on ${baseBranch}.`,
    `The task workspace is already provisioned at /workspace/${directory}; do not run git clone or change the repository remote.`,
    `The Control Plan publication branch is fixed: ${branch}. Pass exactly this branch to finalize_change.`,
    "Follow the repository's instructions, make the requested change, and run the relevant checks.",
    "Use finalize_change only after tests pass and only when a commit/PR is actually requested.",
    "Task:",
    task,
  ].join("\n\n");
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
