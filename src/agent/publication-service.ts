import { repositoryParts, taskIdFromSessionId } from "../mcp/task-utils";
import type { CodingTaskRecord } from "../do/coding-task-do";
import type { PublicationClaimResult } from "../do/publication-lease";
import { pushManifestWithGitHubApi, type PushManifest } from "./github-api-push";
import { GitHubApp } from "./github-app";
import { withCustomSpan, type WorkerTracing } from "../core/tracing";

export type PublicationTaskAccess = {
  get(): Promise<CodingTaskRecord | null>;
  beginPublication(sessionId: string): Promise<PublicationClaimResult>;
};

export type PublicationContext = {
  sessionId: string;
  taskAccess: PublicationTaskAccess;
  tracing?: WorkerTracing;
};

export class PublicationServiceError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 500 | 502,
  ) {
    super(message);
    this.name = "PublicationServiceError";
  }
}

export class PublicationService {
  constructor(private readonly env: Env) {}

  async pushGitManifest(
    manifest: PushManifest,
    context: PublicationContext,
  ): Promise<{
    success: true;
    branch: string;
    sha: string;
    created: boolean;
    verified: true;
    idempotent: boolean;
  }> {
    const task = await this.assertPublishable(manifest.branch, manifest.baseBranch, context);
    const target = repositoryParts(task.repository);
    if (!target) throw new PublicationServiceError("invalid task repository", 500);
    const access = await this.repositoryAccess(task.repository);

    return withCustomSpan(
      context.tracing,
      "control_plan.publication.git_push",
      {
        "control_plan.task_id": task.id,
        "control_plan.repository": task.repository,
        "control_plan.branch": manifest.branch,
        "control_plan.change_count": manifest.changes.length,
      },
      async () => {
        const claim = await context.taskAccess.beginPublication(context.sessionId);
        this.assertClaimed(claim);
        try {
          return {
            success: true as const,
            ...(await pushManifestWithGitHubApi(
              access.client,
              target.owner,
              target.repo,
              manifest,
            )),
          };
        } catch (error) {
          throw new PublicationServiceError(
            `Push failed: ${error instanceof Error ? error.message : String(error)}`,
            502,
          );
        }
      },
    );
  }

  async createPullRequest(
    input: CreatePullRequestInput,
    context: PublicationContext,
  ): Promise<{
    success: true;
    prUrl: string;
    prNumber: number;
    existing: boolean;
  }> {
    const task = await context.taskAccess.get();
    if (!task) throw new PublicationServiceError("session is not bound to a coding task", 409);
    const baseBranch = input.baseBranch ?? task.baseBranch;
    this.assertTaskWritable(task, input.branch, baseBranch);
    const target = repositoryParts(task.repository);
    if (!target) throw new PublicationServiceError("invalid task repository", 500);
    const access = await this.repositoryAccess(task.repository);

    return withCustomSpan(
      context.tracing,
      "control_plan.publication.create_pr",
      {
        "control_plan.task_id": task.id,
        "control_plan.repository": task.repository,
        "control_plan.branch": input.branch,
        "control_plan.base_branch": baseBranch,
      },
      async () => {
        const existing = await access.client.rest.pulls.list({
          owner: target.owner,
          repo: target.repo,
          head: `${target.owner}:${input.branch}`,
          base: baseBranch,
          state: "open",
          per_page: 1,
        });
        const open = existing.data[0];
        if (open) {
          return {
            success: true as const,
            prUrl: open.html_url,
            prNumber: open.number,
            existing: true,
          };
        }

        const claim = await context.taskAccess.beginPublication(context.sessionId);
        this.assertClaimed(claim);
        try {
          const pr = await access.client.rest.pulls.create({
            owner: target.owner,
            repo: target.repo,
            title: input.title,
            body: input.body ?? "",
            head: input.branch,
            base: baseBranch,
            draft: input.draft !== false,
          });
          return {
            success: true as const,
            prUrl: pr.data.html_url,
            prNumber: pr.data.number,
            existing: false,
          };
        } catch (error) {
          throw new PublicationServiceError(
            `PR creation failed: ${error instanceof Error ? error.message : String(error)}`,
            502,
          );
        }
      },
    );
  }

  private async assertPublishable(
    branch: string,
    baseBranch: string | undefined,
    context: PublicationContext,
  ): Promise<CodingTaskRecord> {
    const task = await context.taskAccess.get();
    if (!task) throw new PublicationServiceError("session is not bound to a coding task", 409);
    this.assertTaskWritable(task, branch, baseBranch ?? task.baseBranch);
    return task;
  }

  private assertTaskWritable(task: CodingTaskRecord, branch: string, baseBranch: string): void {
    if (
      task.state === "cancellation_requested" ||
      task.state === "cancelled" ||
      task.state === "completed" ||
      task.state === "failed"
    ) {
      throw new PublicationServiceError(`coding task is ${task.state}`, 409);
    }
    if (branch !== task.branch || baseBranch !== task.baseBranch) {
      throw new PublicationServiceError(
        `branch/baseBranch must be ${task.branch}/${task.baseBranch} for this coding task`,
        409,
      );
    }
  }

  private assertClaimed(claim: PublicationClaimResult): void {
    if (claim.claimed) return;
    throw new PublicationServiceError(
      claim.reason === "owned_by_other_session"
        ? "publication is owned by another session"
        : "coding task is no longer publishable",
      409,
    );
  }

  private async repositoryAccess(repository: string) {
    try {
      return await new GitHubApp(this.env).getRepositoryAccess(repository, "write");
    } catch (error) {
      throw new PublicationServiceError(
        error instanceof Error ? error.message : String(error),
        502,
      );
    }
  }
}

export type CreatePullRequestInput = {
  title: string;
  body?: string;
  branch: string;
  baseBranch?: string;
  draft?: boolean;
};

export function publicationTaskAccess(env: Env, sessionId: string): PublicationTaskAccess | null {
  const taskId = taskIdFromSessionId(sessionId);
  const binding = (env as Partial<Env>).CONTROL_PLAN_TASK_DO;
  if (!taskId || !binding) return null;
  return binding.get(binding.idFromName(taskId));
}
