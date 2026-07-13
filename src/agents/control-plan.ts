import {
  defineAgent,
  defineTool,
  registerProvider,
  type AgentRouteHandler,
  type JsonValue,
} from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";
import * as v from "valibot";
import { requireApproval } from "../approval";
import type { ApprovalDecision, ApprovalMode } from "../approval";
import { requiresPublicationApproval } from "../agent/publication-policy";
import { signScopedToken } from "../core/auth";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  buildPushSnapshot,
  assertWorkspaceRepository,
  ensureWorkspaceCommitted,
  findWorkspaceRepo,
  runDeterministicFinalize,
  shellQuote,
  type FinalizeCheckpoint,
  type FinalizeRequest,
} from "../agent/finalizer";
import type { CodingTaskRecord, CodingTaskResult } from "../do/coding-task-do";
import { taskIdFromSessionId } from "../mcp/task-utils";
import { withDefaultExecTimeout } from "../agent/sandbox-timeout";
import { GitHubApp } from "../agent/github-app";

const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 15 * 60 * 1000;

const INSTRUCTIONS = `
You are the Control Plan PR coding agent. You work autonomously to complete coding tasks and open pull requests.

1. Read the task and understand what needs to be done.
2. Call clone_repository with the task repository and base branch. Do not run git clone yourself; the tool keeps private-repository read credentials out of the model shell.
3. Read relevant files, understand the codebase.
4. Make changes using read, write, edit, and bash tools.
5. Run install_deps after cloning (bash: cd repo && npm install).
6. Run tests to verify (bash: cd repo && npm test).
7. When satisfied, DO NOT commit or push manually.
8. Call mark_ready_to_finalize with the exact fixed branch from the task prompt, commit message, and PR title/body. The control plane will commit, push, and create or update the PR deterministically.

## RULES
- Do NOT call mark_ready_to_finalize unless tests pass.
- Do NOT run git commit, git push, or gh pr commands yourself.
- Keep changes narrow. Do not refactor unrelated code.
- Run tests BEFORE finalizing.
- Write clean, conventional commit messages.
- For follow-up work on an existing PR, call mark_ready_to_finalize with createPr=false so the same branch is updated without creating a second PR.

## APPROVAL
Production uses policy mode: normal task-branch pushes and draft PRs are autonomous after checks pass. Force pushes, non-task branches, sensitive paths, and non-draft PR publication require approval. Manual mode requires approval for every GitHub publication. Approval is surfaced through the Hermes gateway's native MCP elicitation; never treat a tool argument as proof that a human approved.
- If error says "denied by operator": user explicitly denied. DO NOT retry. Stop and explain.
- If error says "blocked by hardline policy": never allowed. DO NOT retry under any circumstance.
- If error says "no approval received within 1 hour" (timeout): user may have been AFK. Stop, report the issue, mention that the user can re-run when ready. DO NOT retry automatically.
Always include the replay URL so the operator can review.
`;

export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent<Env>(({ id, env }) => {
  if (env.ZAI_API_KEY) registerProvider("zai", { apiKey: env.ZAI_API_KEY });
  const baseUrl = env.WORKER_URL || "";
  // Cast to handle generic variance issues
  const approvalDO = env.APPROVAL_DO as unknown as DurableObjectNamespace;
  const authorName = env.GITHUB_USER_LOGIN || "Control Plan";
  const authorEmail =
    (env as Env & { GITHUB_USER_EMAIL?: string }).GITHUB_USER_EMAIL ||
    "control-plan-bot@users.noreply.github.com";
  const sandbox = () =>
    getSandbox(env.Sandbox, `control-plan-${id}`, {
      sleepAfter: "5m",
      transport: "rpc",
      enableDefaultSession: false,
      normalizeId: true,
    });

  const taskId = taskIdFromSessionId(id);
  const taskStub = taskId
    ? env.CONTROL_PLAN_TASK_DO.get(env.CONTROL_PLAN_TASK_DO.idFromName(taskId))
    : null;

  async function taskRecord(): Promise<CodingTaskRecord | null> {
    return taskStub ? taskStub.get() : null;
  }

  async function recordFinalizeResult(
    result: {
      push: JsonValue;
      pr: JsonValue | null;
    },
    branch: string,
  ): Promise<void> {
    if (!taskStub) return;
    const push = asRecord(result.push);
    const pr = asRecord(result.pr);
    const taskResult: CodingTaskResult = {
      branch,
      commitSha: asString(push?.sha),
      prUrl: asString(pr?.prUrl),
      prNumber: asNumber(pr?.prNumber),
    };
    await taskStub.markFinalized(taskResult);
  }

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
    )
      return null;
    const decision = await requireApproval(
      { signal: ctx.signal },
      {
        type: "git_push",
        title: `Push to branch ${snapshot.branch}`,
        command: `Publish ${snapshot.changes.length} file change(s) to ${snapshot.branch}${snapshot.force ? " with force" : ""}`,
        pattern: "git.push",
        metadata: {
          headSha: snapshot.headSha,
          baseSha: snapshot.baseSha,
          baseTreeSha: snapshot.baseTreeSha,
          branch: snapshot.branch,
          changes: snapshot.changes.length,
          paths: snapshot.changes
            .slice(0, 20)
            .map((change) => (change && typeof change === "object" ? (change as { path?: string }).path : undefined))
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
    const resp = await fetch(`${baseUrl}/proxy/git-push`, {
      method: "POST",
      headers: await proxyHeaders(),
      body: JSON.stringify(snapshot),
      signal: ctx.signal,
    });
    if (!resp.ok) throw new Error(`Push failed: ${resp.status} ${await resp.text()}`);
    const result = (await resp.json()) as { success?: boolean; error?: string };
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
          diff: input.body?.slice(0, 2000),
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

    const resp = await fetch(`${baseUrl}/proxy/create-pr`, {
      method: "POST",
      headers: await proxyHeaders(),
      body: JSON.stringify({ ...input, draft: input.draft !== false }),
      signal: ctx.signal,
    });
    if (!resp.ok) throw new Error(`PR creation failed: ${resp.status} ${await resp.text()}`);
    return (await resp.json()) as JsonValue;
  }

  async function loadFinalizeCheckpoint(branch: string): Promise<FinalizeCheckpoint | null> {
    const stub = approvalDO.get(approvalDO.idFromName("approvals"));
    const url = new URL("/finalize-checkpoint", "http://localhost");
    url.searchParams.set("session_id", id);
    url.searchParams.set("branch", branch);
    const response = await stub.fetch(url);
    if (!response.ok) {
      throw new Error(`Could not load finalize checkpoint: ${response.status}`);
    }
    const body = (await response.json()) as {
      checkpoint?: FinalizeCheckpoint | null;
    };
    return body.checkpoint ?? null;
  }

  async function saveFinalizeCheckpoint(checkpoint: FinalizeCheckpoint): Promise<void> {
    const stub = approvalDO.get(approvalDO.idFromName("approvals"));
    const response = await stub.fetch(new URL("/finalize-checkpoint", "http://localhost"), {
      method: "POST",
      body: JSON.stringify({
        sessionId: id,
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

  const cloneRepository = defineTool({
    name: "clone_repository",
    description:
      "Clone the task-bound GitHub repository into /workspace. Uses a short-lived scoped read credential for private repositories without exposing it to the model shell.",
    input: v.object({
      repository: v.string(),
      baseBranch: v.string(),
    }),
    async run(ctx) {
      const task = await taskRecord();
      if (!task) throw new Error("clone_repository is available only for MCP-created coding tasks");
      if (ctx.input.repository !== task.repository || ctx.input.baseBranch !== task.baseBranch) {
        throw new Error("clone_repository input does not match the task repository or base branch");
      }

      const [owner, repo] = task.repository.split("/");
      const repoPath = `/workspace/${repo}`;
      const askpassPath = `/tmp/control-plan-askpass-${task.id.slice(-12)}`;
      const githubAccess = await new GitHubApp(env).getRepositoryAccess(task.repository, "read");
      const command = [
        "set -eu",
        `if [ -d ${shellQuote(`${repoPath}/.git`)} ]; then exit 0; fi`,
        `rm -rf ${shellQuote(repoPath)}`,
        `askpass=${shellQuote(askpassPath)}`,
        `trap 'rm -f "$askpass"' EXIT`,
        `printf '%s\\n' '#!/bin/sh' 'printf "%s\\n" "$CONTROL_PLAN_GITHUB_APP_TOKEN"' > "$askpass"`,
        `chmod 700 "$askpass"`,
        `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$askpass" git -c credential.helper= clone --branch ${shellQuote(task.baseBranch)} --single-branch https://x-access-token@github.com/${owner}/${repo}.git ${shellQuote(repoPath)}`,
      ].join("\n");

      const result = await sandbox().exec(command, {
        timeout: DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
        env: { CONTROL_PLAN_GITHUB_APP_TOKEN: githubAccess.token },
      });
      if (result.exitCode !== 0) {
        throw new Error(`Repository clone failed: ${result.stderr || result.stdout}`);
      }
      return {
        repository: task.repository,
        baseBranch: task.baseBranch,
        path: repoPath,
      } as JsonValue;
    },
  });

  const gitPush = defineTool({
    name: "git_push",
    description:
      "Push local commits to GitHub. Publication policy may allow a task-branch push autonomously; exceptional pushes use Hermes native approval. Call after git add + git commit.",
    input: v.object({
      branch: v.string(),
      force: v.optional(v.boolean(), false),
    }),
    async run(ctx) {
      const { branch, force } = ctx.input;
      const task = await taskRecord();
      if (task?.state === "cancellation_requested") {
        throw new Error("coding task cancellation requested; publication is blocked");
      }
      if (task && branch !== task.branch) {
        throw new Error(`git_push branch must be the task branch ${task.branch}`);
      }

      // ── 1. Snapshot the commit as a manifest BEFORE asking for approval ─
      // This way the container can sleep during the wait without losing work.
      const preSandbox = sandbox();
      const repoPath = await findWorkspaceRepo(preSandbox);
      if (task) await assertWorkspaceRepository(preSandbox, repoPath, task.repository);
      const snapshot = await buildPushSnapshot(
        preSandbox,
        repoPath,
        branch,
        force,
        task?.baseBranch || "main",
      );

      // ── 2. Request approval (container free to sleep during wait) ───────
      await requireGitPushApproval(ctx, snapshot);

      // ── 3. Publish through the control plane; sandbox never receives the token.
      return pushSnapshot(ctx, snapshot);
    },
  });

  const createPR = defineTool({
    name: "create_pr",
    description:
      "Create a GitHub Pull Request. Draft PRs may be automatic in policy mode; non-draft publication uses Hermes native approval. Only call after git_push succeeded.",
    input: v.object({
      title: v.string(),
      body: v.string(),
      branch: v.string(),
      baseBranch: v.optional(v.string()),
      draft: v.optional(v.boolean()),
    }),
    async run(ctx) {
      const { title, body, branch, baseBranch, draft } = ctx.input;
      const task = await taskRecord();
      const resolvedBaseBranch = task?.baseBranch || baseBranch || "main";
      if (task?.state === "cancellation_requested") {
        throw new Error("coding task cancellation requested; publication is blocked");
      }
      if (task && (branch !== task.branch || resolvedBaseBranch !== task.baseBranch)) {
        throw new Error(
          `create_pr must use task branch ${task.branch} and base branch ${task.baseBranch}`,
        );
      }
      return createPullRequest(ctx, {
        title,
        body,
        branch,
        baseBranch: resolvedBaseBranch,
        draft: draft ?? approvalMode(env.APPROVAL_MODE) === "policy",
      });
    },
  });

  const markReadyToFinalize = defineTool({
    name: "mark_ready_to_finalize",
    description:
      "Finalize verified work deterministically. Commits current sandbox changes, pushes via the control plane, and optionally creates or updates the PR. Prefer this over manual git commit/git_push/create_pr.",
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
    async run(ctx) {
      const { branch, commitMessage, prTitle, prBody, baseBranch, createPr, force, draft } = ctx.input;
      const task = await taskRecord();
      const resolvedBaseBranch = task?.baseBranch || baseBranch || "main";
      if (task?.state === "cancellation_requested") {
        throw new Error("coding task cancellation requested; finalization is blocked");
      }
      if (task && (branch !== task.branch || resolvedBaseBranch !== task.baseBranch)) {
        throw new Error(
          `mark_ready_to_finalize must use task branch ${task.branch} and base branch ${task.baseBranch}`,
        );
      }
      const request: FinalizeRequest = {
        repository: task?.repository || "",
        branch,
        commitMessage,
        prTitle,
        prBody: prBody || "",
        baseBranch: resolvedBaseBranch,
        createPr: createPr ?? true,
        force: force ?? false,
        draft: draft ?? approvalMode(env.APPROVAL_MODE) === "policy",
      };

      const result = await runDeterministicFinalize(request, {
        loadCheckpoint: () => loadFinalizeCheckpoint(branch),
        saveCheckpoint: saveFinalizeCheckpoint,
        async prepare() {
          const taskSandbox = sandbox();
          const repoPath = await findWorkspaceRepo(taskSandbox);
          if (task) await assertWorkspaceRepository(taskSandbox, repoPath, task.repository);
          await ensureWorkspaceCommitted(
            taskSandbox,
            repoPath,
            commitMessage,
            authorName,
            authorEmail,
          );
          return buildPushSnapshot(taskSandbox, repoPath, branch, force, resolvedBaseBranch);
        },
        approvePush: (snapshot) => requireGitPushApproval(ctx, snapshot),
        push: (snapshot) => pushSnapshot(ctx, snapshot),
        createPr: (input) => createPullRequest(ctx, input),
      });
      await recordFinalizeResult(result, branch);
      return result;
    },
  });

  return {
    model: env.LLM_MODEL || "anthropic/claude-sonnet-4-6",
    instructions: INSTRUCTIONS,
    tools: [cloneRepository, markReadyToFinalize, gitPush, createPR],
    sandbox: withDefaultExecTimeout(
      cloudflareSandbox(sandbox(), { cwd: "/workspace" }),
      DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
    ),
    durability: {
      maxAttempts: 10,
      // 2 hours: enough for 1h HITL approval wait + agent work
      timeoutMs: 2 * 60 * 60 * 1000,
    },
  };
});

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
