import { defineAction, type JsonValue } from "@flue/runtime";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import * as v from "valibot";
import { requireApproval } from "../approval";
import type { ApprovalDecision, ApprovalMode } from "../approval";
import { requiresPublicationApproval } from "./publication-policy";
import {
  buildPushSnapshot,
  assertWorkspaceRepository,
  ensureWorkspaceCommitted,
  findWorkspaceRepo,
  runDeterministicFinalize,
  type FinalizeCheckpoint,
  type FinalizeRequest,
  type SandboxLike,
} from "./finalizer";
import type { CodingTaskRecord, CodingTaskResult } from "../do/coding-task-do";
import { signScopedToken } from "../core/auth";

type TaskStub = {
  get(): Promise<CodingTaskRecord | null>;
  recordPublication(result: CodingTaskResult): Promise<CodingTaskRecord | null>;
};

export type ControlPlanFinalizeContext = {
  env: Env;
  id: string;
  baseUrl: string;
  approvalDO: DurableObjectNamespace;
  taskStub: TaskStub | null;
  taskRecord: () => Promise<CodingTaskRecord | null>;
  sandboxSession: () => Promise<SandboxLike>;
  authorName: string;
  authorEmail: string;
};

export function createFinalizeChangeAction(context: ControlPlanFinalizeContext) {
  const {
    env,
    id,
    baseUrl,
    approvalDO,
    taskStub,
    taskRecord,
    sandboxSession,
    authorName,
    authorEmail,
  } = context;

  async function proxyHeaders(): Promise<Record<string, string>> {
    if (!baseUrl) throw new Error("WORKER_URL must be configured for agent callbacks");
    const token = await signScopedToken(
      env.CONTROL_PLAN_PROXY_SECRET || "",
      "proxy",
      id,
      5 * 60 * 1000,
    );
    return {
      "Content-Type": "application/json",
      "X-Control-Plan-Session-Id": id,
      Authorization: `Bearer ${token}`,
    };
  }

  async function requireGitPushApproval(
    ctx: { signal?: AbortSignal },
    snapshot: {
      branch: string;
      force?: boolean;
      headSha: string;
      baseSha: string;
      baseTreeSha: string;
      changes: unknown[];
      manifestKB: number;
    },
  ): Promise<ApprovalDecision | null> {
    const mode = approvalMode(env.APPROVAL_MODE);
    if (
      !requiresPublicationApproval(mode, "git_push", {
        ...snapshot,
        changes: snapshot.changes as Array<{ path?: string }>,
      })
    ) {
      return null;
    }
    const decision = await requireApproval(
      { signal: ctx.signal },
      {
        type: "git_push",
        title: `Push to branch ${snapshot.branch}`,
        command: `Publish ${snapshot.changes.length} file(s) to ${snapshot.branch}${snapshot.force ? " with force" : ""}`,
        pattern: "git.push",
        metadata: {
          headSha: snapshot.headSha,
          baseSha: snapshot.baseSha,
          baseTreeSha: snapshot.baseTreeSha,
          branch: snapshot.branch,
          changes: snapshot.changes.length,
          paths: snapshot.changes
            .slice(0, 20)
            .map((change) =>
              change && typeof change === "object" ? (change as { path?: string }).path : undefined,
            )
            .filter((path): path is string => Boolean(path)),
          manifestKB: snapshot.manifestKB,
        },
      },
      {
        mode,
        sessionId: id,
        workerUrl: baseUrl,
        approvalDOBinding: approvalDO,
      },
    );

    if (decision.denied) {
      throw new Error(
        `Push to ${snapshot.branch} was ${approvalDeniedReason(decision.decision)}. ` +
          `Operator can approve at ${baseUrl}/replay/${id}.`,
      );
    }
    return decision;
  }

  async function pushSnapshot(
    ctx: { signal?: AbortSignal },
    snapshot: unknown,
  ): Promise<JsonValue> {
    const response = await fetch(`${baseUrl}/proxy/git-push`, {
      method: "POST",
      headers: await proxyHeaders(),
      body: JSON.stringify(snapshot),
      signal: ctx.signal,
    });
    if (!response.ok) throw new Error(`Push failed: ${response.status} ${await response.text()}`);
    const result = (await response.json()) as {
      success?: boolean;
      error?: string;
    };
    if (!result.success) throw new Error(`Push failed: ${result.error || "unknown error"}`);
    return result as JsonValue;
  }

  async function createPullRequest(
    ctx: { signal?: AbortSignal },
    input: {
      title: string;
      body: string;
      branch: string;
      baseBranch: string;
      draft?: boolean;
    },
  ): Promise<JsonValue> {
    const mode = approvalMode(env.APPROVAL_MODE);
    if (requiresPublicationApproval(mode, "create_pr", input)) {
      const decision = await requireApproval(
        { signal: ctx.signal },
        {
          type: "create_pr",
          title: `Create PR: "${input.title}"`,
          command: `Create PR from ${input.branch} to ${input.baseBranch}`,
          diff: input.body.slice(0, 2000),
          pattern: "pr.create",
        },
        {
          mode,
          sessionId: id,
          workerUrl: baseUrl,
          approvalDOBinding: approvalDO,
        },
      );
      if (decision.denied) {
        throw new Error(
          `PR creation was ${approvalDeniedReason(decision.decision)}. ` +
            `Operator can approve at ${baseUrl}/replay/${id}.`,
        );
      }
    }

    const response = await fetch(`${baseUrl}/proxy/create-pr`, {
      method: "POST",
      headers: await proxyHeaders(),
      body: JSON.stringify({ ...input, draft: input.draft !== false }),
      signal: ctx.signal,
    });
    if (!response.ok) {
      throw new Error(`PR creation failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as JsonValue;
  }

  return defineAction({
    name: "finalize_change",
    description:
      "Finalize verified work deterministically. Commits current sandbox changes, publishes through the Control Plane, and optionally creates or updates the pull request.",
    input: v.object({
      branch: v.string(),
      commitMessage: v.string(),
      prTitle: v.optional(v.string()),
      prBody: v.optional(v.string(), ""),
      baseBranch: v.optional(v.string()),
      createPr: v.optional(v.boolean(), true),
      force: v.optional(v.boolean(), false),
      draft: v.optional(v.boolean()),
    }),
    output: v.object({
      success: v.boolean(),
      push: v.unknown(),
      pr: v.nullable(v.unknown()),
      recovered: v.boolean(),
    }),
    async run({ input, log }) {
      const currentTask = await taskRecord();
      const resolvedBaseBranch = currentTask?.baseBranch || input.baseBranch || "main";
      if (currentTask?.state === "cancellation_requested" || currentTask?.state === "cancelled") {
        throw new Error("coding task cancellation requested; finalization is blocked");
      }
      if (
        currentTask &&
        (input.branch !== currentTask.branch || resolvedBaseBranch !== currentTask.baseBranch)
      ) {
        throw new Error(
          `finalize_change must use task branch ${currentTask.branch} and base branch ${currentTask.baseBranch}`,
        );
      }

      const request: FinalizeRequest = {
        repository: currentTask?.repository || "",
        branch: input.branch,
        commitMessage: input.commitMessage,
        prTitle: input.prTitle,
        prBody: input.prBody,
        baseBranch: resolvedBaseBranch,
        createPr: input.createPr,
        force: input.force,
        draft: input.draft ?? approvalMode(env.APPROVAL_MODE) === "policy",
      };
      const result = await runDeterministicFinalize(request, {
        loadCheckpoint: () => loadFinalizeCheckpoint(approvalDO, id, input.branch),
        saveCheckpoint: (checkpoint) => saveFinalizeCheckpoint(approvalDO, id, checkpoint),
        async prepare() {
          const taskSandbox = await sandboxSession();
          const repoPath = await findWorkspaceRepo(taskSandbox);
          if (currentTask)
            await assertWorkspaceRepository(taskSandbox, repoPath, currentTask.repository);
          await ensureWorkspaceCommitted(
            taskSandbox,
            repoPath,
            input.commitMessage,
            authorName,
            authorEmail,
          );
          return buildPushSnapshot(
            taskSandbox,
            repoPath,
            input.branch,
            input.force,
            resolvedBaseBranch,
          );
        },
        approvePush: (snapshot) => requireGitPushApproval({}, snapshot),
        push: (snapshot) => pushSnapshot({}, snapshot),
        createPr: (prInput) => createPullRequest({}, prInput),
      });
      if (taskStub) {
        const push = asRecord(result.push);
        const pr = asRecord(result.pr);
        await taskStub.recordPublication({
          branch: input.branch,
          commitSha: asString(push?.sha),
          prUrl: asString(pr?.prUrl),
          prNumber: asNumber(pr?.prNumber),
        });
      }
      log.info("Control Plan finalization completed", {
        recovered: result.recovered,
      });
      return result;
    },
  });
}

async function loadFinalizeCheckpoint(
  approvalDO: DurableObjectNamespace,
  sessionId: string,
  branch: string,
): Promise<FinalizeCheckpoint | null> {
  const stub = approvalDO.get(approvalDO.idFromName("approvals"));
  const url = new URL("/finalize-checkpoint", "http://localhost");
  url.searchParams.set("session_id", sessionId);
  url.searchParams.set("branch", branch);
  const response = await stub.fetch(url);
  if (!response.ok) throw new Error(`Could not load finalize checkpoint: ${response.status}`);
  const body = (await response.json()) as {
    checkpoint?: FinalizeCheckpoint | null;
  };
  return body.checkpoint ?? null;
}

async function saveFinalizeCheckpoint(
  approvalDO: DurableObjectNamespace,
  sessionId: string,
  checkpoint: FinalizeCheckpoint,
): Promise<void> {
  const stub = approvalDO.get(approvalDO.idFromName("approvals"));
  const response = await stub.fetch(new URL("/finalize-checkpoint", "http://localhost"), {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      branch: checkpoint.request.branch,
      checkpoint,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Could not save finalize checkpoint: ${response.status} ${await response.text()}`,
    );
  }
}

function approvalDeniedReason(decision: string): string {
  if (decision === "hardline_blocked") return "blocked by hardline policy (never allowed)";
  if (decision === "timeout") return "no approval received within 1 hour";
  return "denied by operator";
}

function approvalMode(value: string | undefined): ApprovalMode {
  if (value === "policy" || value === "smart" || value === "off") return value;
  return "manual";
}

function asRecord(value: JsonValue | null | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}
