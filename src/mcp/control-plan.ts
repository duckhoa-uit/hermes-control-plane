import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { signScopedToken } from "../core/auth";
import { GitHubApp, GitHubAppError } from "../agent/github-app";
import type { CodingTaskRecord } from "../do/coding-task-do";
import { codingTaskId, taskStateFromHistory, taskBranch } from "./task-utils";

type InternalFetch = (request: Request) => Promise<Response>;

export type ControlPlanMcpOptions = {
  env: Env;
  origin: string;
  fetch: InternalFetch;
};

export function isAuthorizedMcpRequest(request: Request, env: Env): boolean {
  const token = env.CONTROL_PLAN_MCP_TOKEN;
  return Boolean(token) && request.headers.get("Authorization") === `Bearer ${token}`;
}

export async function createControlPlanMcpHandler(options: ControlPlanMcpOptions) {
  const { createMcpHandler } = await import("agents/mcp");
  const server = new McpServer({ name: "control-plan", version: "0.1.0" });

  server.registerTool(
    "spawn_coding_task",
    {
      description:
        "Start a policy-checked Control Plan coding task in Flue and Cloudflare Sandbox.",
      inputSchema: z.object({
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        task: z.string().min(1).max(8000),
        baseBranch: z.string().min(1).max(255).optional(),
        idempotencyKey: z.string().min(1).max(128),
      }),
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

      const id = await codingTaskId(repository, idempotencyKey);
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
        return toolResult(created.task);
      }

      const claim = await stub.claimDispatch();
      if (!claim.claimed) return toolResult(claim.task ?? created.task);

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

      let dispatch: Response;
      try {
        dispatch = await options.fetch(
          new Request(`${options.origin}/agents/control-plan/${sessionId}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${await internalAgentToken(options.env, sessionId)}`,
            },
            body: JSON.stringify({
              message: codingPrompt(repository, resolvedBaseBranch, branch, task),
            }),
          }),
        );
      } catch (error) {
        const failed = await stub.markFailed(String(error));
        return toolError(failed?.error || "Flue dispatch failed");
      }
      const body = (await dispatch.json().catch(() => ({}))) as {
        submissionId?: string;
        offset?: string;
        error?: string;
      };

      if (!dispatch.ok) {
        const failed = await stub.markFailed(
          body.error || `Flue dispatch failed with ${dispatch.status}`,
        );
        return toolError(failed?.error || "Flue dispatch failed");
      }

      const admitted = await stub.markDispatched({
        submissionId: body.submissionId,
        streamOffset: body.offset,
      });
      return toolResult(admitted ?? created.task);
    },
  );

  server.registerTool(
    "get_coding_task",
    {
      description:
        "Get the durable status, replay URL, and open approval requests for a coding task.",
      inputSchema: z.object({ taskId: z.string().regex(/^task_[a-f0-9]{32}$/) }),
      annotations: { readOnlyHint: true },
    },
    async ({ taskId }) => {
      const task = await refreshTask(taskId, options);
      if (!task) return toolError(`Coding task ${taskId} was not found.`);
      const approvals = await openApprovals(task.sessionId, options);
      return toolResult({ ...task, approvals });
    },
  );

  server.registerTool(
    "respond_coding_approval",
    {
      description:
        "Complete native Hermes approval for a pending Control Plan publication. The decision argument is only a hint; non-deny requests invoke MCP elicitation/create and record the gateway's accept or decline result.",
      inputSchema: z.object({
        taskId: z.string().regex(/^task_[a-f0-9]{32}$/),
        approvalId: z.string().min(1).max(255),
        decision: z.enum(["once", "session", "always", "deny"]),
      }),
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
                      description: "The Control Plan will perform the described GitHub publication.",
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
      return toolResult({ taskId, approval: resolved });
    },
  );

  server.registerTool(
    "cancel_coding_task",
    {
      description:
        "Request cancellation and abort the running Flue submission. Publication is blocked after cancellation.",
      inputSchema: z.object({ taskId: z.string().regex(/^task_[a-f0-9]{32}$/) }),
    },
    async ({ taskId }) => {
      const task = await taskStub(options.env, taskId).requestCancellation();
      if (!task) return toolError(`Coding task ${taskId} was not found.`);
      if (task.state === "completed" || task.state === "failed") {
        return toolResult({ ...task, cancellation: "already_terminal" });
      }
      let abortRequested = false;
      try {
        const abortResponse = await options.fetch(
          new Request(`${options.origin}/agents/control-plan/${task.sessionId}/abort`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${await internalAgentToken(options.env, task.sessionId)}`,
            },
          }),
        );
        const body = (await abortResponse.json().catch(() => ({}))) as { aborted?: boolean };
        abortRequested = abortResponse.ok && body.aborted === true;
      } catch {
        // Durable task state remains cancellation_requested even if transport abort is unavailable.
      }
      return toolResult({
        ...task,
        cancellation: abortRequested ? "requested_and_aborted" : "requested",
      });
    },
  );

  // Native Hermes elicitation is a server-initiated request nested inside the
  // tool call. It requires the MCP SSE response to remain bidirectional;
  // JSON-only responses cannot carry that nested request.
  return createMcpHandler(server, { route: "/mcp", enableJsonResponse: false });
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
  if (
    !task ||
    (task.state !== "dispatched" && task.state !== "cancellation_requested") ||
    !task.streamOffset
  ) {
    return task;
  }

  const response = await options.fetch(
    new Request(`${options.origin}/agents/control-plan/${task.sessionId}?view=history`, {
      headers: { Authorization: `Bearer ${await internalAgentToken(options.env, task.sessionId)}` },
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

function codingPrompt(
  repository: string,
  baseBranch: string,
  branch: string,
  task: string,
): string {
  const directory = repository.split("/")[1];
  return [
    `Work only on https://github.com/${repository}.git, based on ${baseBranch}.`,
    `Call clone_repository for ${repository} on ${baseBranch}; it will clone into /workspace/${directory} with scoped read access when needed. Do not run git clone yourself.`,
    `The Control Plan publication branch is fixed: ${branch}. Pass exactly this branch to mark_ready_to_finalize.`,
    "Follow the repository's instructions, make the requested change, and run the relevant checks.",
    "Use mark_ready_to_finalize only after tests pass and only when a commit/PR is actually requested.",
    "Task:",
    task,
  ].join("\n\n");
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
