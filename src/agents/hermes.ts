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
import { signToken } from "../core/auth";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  buildPushSnapshot,
  ensureWorkspaceCommitted,
  findWorkspaceRepo,
  runDeterministicFinalize,
  type FinalizeCheckpoint,
  type FinalizeRequest,
} from "../agent/finalizer";
import { withDefaultExecTimeout } from "../agent/sandbox-timeout";

const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 15 * 60 * 1000;

const INSTRUCTIONS = `
You are Hermes, a PR coding agent. You work autonomously to complete coding tasks and open pull requests.

1. Read the task and understand what needs to be done.
2. Clone the repository: git clone <url>
3. Read relevant files, understand the codebase.
4. Make changes using read, write, edit, and bash tools.
5. Run install_deps after cloning (bash: cd repo && npm install).
6. Run tests to verify (bash: cd repo && npm test).
7. When satisfied, DO NOT commit or push manually.
8. Call mark_ready_to_finalize with the branch, commit message, and PR title/body. The control plane will commit, push, and create or update the PR deterministically.

## RULES
- Do NOT call mark_ready_to_finalize unless tests pass.
- Do NOT run git commit, git push, or gh pr commands yourself.
- Keep changes narrow. Do not refactor unrelated code.
- Run tests BEFORE finalizing.
- Write clean, conventional commit messages.
- For follow-up work on an existing PR, call mark_ready_to_finalize with createPr=false so the same branch is updated without creating a second PR.

## APPROVAL
Some powerful operations (mark_ready_to_finalize, git_push, create_pr) may require human approval.
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
  const authorName = env.GITHUB_USER_LOGIN || "Hermes";
  const authorEmail =
    (env as Env & { GITHUB_USER_EMAIL?: string }).GITHUB_USER_EMAIL ||
    "hermes-bot@users.noreply.github.com";

  async function proxyHeaders(): Promise<Record<string, string>> {
    return {
      "Content-Type": "application/json",
      "X-Hermes-Session-Id": id,
      Authorization: `Bearer ${await signToken(env.GITHUB_WEBHOOK_SECRET, id)}`,
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
  ) {
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
          changes: snapshot.changes.length,
          manifestKB: snapshot.manifestKB,
        },
      },
      {
        mode: (env.APPROVAL_MODE || "manual") as "manual" | "smart" | "off",
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
    },
  ): Promise<JsonValue> {
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
        mode: (env.APPROVAL_MODE || "manual") as "manual" | "smart" | "off",
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

    const resp = await fetch(`${baseUrl}/proxy/create-pr`, {
      method: "POST",
      headers: await proxyHeaders(),
      body: JSON.stringify(input),
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

  const gitPush = defineTool({
    name: "git_push",
    description:
      "Push local commits to GitHub. REQUIRES HUMAN APPROVAL before executing. Call after git add + git commit.",
    input: v.object({
      branch: v.string(),
      force: v.optional(v.boolean(), false),
    }),
    async run(ctx) {
      const { branch, force } = ctx.input;

      // ── 1. Snapshot the commit as a manifest BEFORE asking for approval ─
      // This way the container can sleep during the wait without losing work.
      const preSandbox = getSandbox(env.Sandbox, `hermes-${id}`, {
        sleepAfter: "5m",
      });
      const repoPath = await findWorkspaceRepo(preSandbox);
      const snapshot = await buildPushSnapshot(preSandbox, repoPath, branch, force);

      // ── 2. Request approval (container free to sleep during wait) ───────
      await requireGitPushApproval(ctx, snapshot);

      // ── 3. Publish through the control plane; sandbox never receives the token.
      return pushSnapshot(ctx, snapshot);
    },
  });

  const createPR = defineTool({
    name: "create_pr",
    description:
      "Create a GitHub Pull Request. REQUIRES HUMAN APPROVAL before executing. Only call after git_push succeeded.",
    input: v.object({
      title: v.string(),
      body: v.string(),
      branch: v.string(),
      baseBranch: v.optional(v.string(), "main"),
    }),
    async run(ctx) {
      const { title, body, branch, baseBranch } = ctx.input;
      return createPullRequest(ctx, {
        title,
        body,
        branch,
        baseBranch: baseBranch || "main",
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
      baseBranch: v.optional(v.string(), "main"),
      createPr: v.optional(v.boolean(), true),
      force: v.optional(v.boolean(), false),
    }),
    async run(ctx) {
      const { branch, commitMessage, prTitle, prBody, baseBranch, createPr, force } = ctx.input;
      const request: FinalizeRequest = {
        branch,
        commitMessage,
        prTitle,
        prBody: prBody || "",
        baseBranch: baseBranch || "main",
        createPr: createPr ?? true,
        force: force ?? false,
      };

      return runDeterministicFinalize(request, {
        loadCheckpoint: () => loadFinalizeCheckpoint(branch),
        saveCheckpoint: saveFinalizeCheckpoint,
        async prepare() {
          const sandbox = getSandbox(env.Sandbox, `hermes-${id}`, {
            sleepAfter: "5m",
          });
          const repoPath = await findWorkspaceRepo(sandbox);
          await ensureWorkspaceCommitted(sandbox, repoPath, commitMessage, authorName, authorEmail);
          return buildPushSnapshot(sandbox, repoPath, branch, force);
        },
        approvePush: (snapshot) => requireGitPushApproval(ctx, snapshot),
        push: (snapshot) => pushSnapshot(ctx, snapshot),
        createPr: (input) => createPullRequest(ctx, input),
      });
    },
  });

  return {
    model: env.LLM_MODEL || "anthropic/claude-sonnet-4-6",
    instructions: INSTRUCTIONS,
    tools: [markReadyToFinalize, gitPush, createPR],
    sandbox: withDefaultExecTimeout(
      cloudflareSandbox(getSandbox(env.Sandbox, `hermes-${id}`, { sleepAfter: "5m" }), {
        cwd: "/workspace",
      }),
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
