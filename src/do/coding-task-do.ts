import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import { claimPublication, type PublicationClaimResult } from "./publication-lease";
import type { CodingTaskWorkflowOutput } from "../core/coding-task-contract";
import { settleCodingTaskRecord } from "../core/coding-task-settlement";

export type CodingTaskState =
  | "created"
  | "dispatching"
  | "dispatched"
  | "publishing"
  | "completed"
  | "failed"
  | "cancellation_requested"
  | "cancelled";

export type CodingTaskExecutionMode = "agent" | "workflow";

export type CodingTaskResult = {
  branch: string;
  commitSha?: string;
  prUrl?: string;
  prNumber?: number;
};

export interface CodingTaskRecord {
  id: string;
  sessionId: string;
  repository: string;
  baseBranch: string;
  branch: string;
  task: string;
  executionMode?: CodingTaskExecutionMode;
  state: CodingTaskState;
  createdAt: number;
  updatedAt: number;
  replayUrl: string;
  submissionId?: string;
  streamOffset?: string;
  summary?: string;
  error?: string;
  outcome?: CodingTaskWorkflowOutput["outcome"];
  verification?: CodingTaskWorkflowOutput["verification"];
  blockedReason?: string;
  result?: CodingTaskResult;
  workflowRunId?: string;
  publicationSessionId?: string;
  publicationStartedAt?: number;
}

export interface CreateCodingTaskInput {
  id: string;
  sessionId: string;
  repository: string;
  baseBranch: string;
  branch: string;
  task: string;
  replayUrl: string;
  executionMode?: CodingTaskExecutionMode;
}

const TASK_KEY = "task";
const MAX_TASK_LIFETIME_MS = 3 * 60 * 60 * 1000;
const SANDBOX_SLEEP_AFTER = "5m";
const SANDBOX_DESTROY_TIMEOUT_MS = 15_000;

export class ControlPlanTaskDurableObject extends DurableObject<Env> {
  async create(
    input: CreateCodingTaskInput,
  ): Promise<{ task: CodingTaskRecord; created: boolean; conflict?: string }> {
    const existing = await this.ctx.storage.get<CodingTaskRecord>(TASK_KEY);
    if (existing) {
      if (
        existing.repository !== input.repository ||
        existing.baseBranch !== input.baseBranch ||
        existing.task !== input.task
      ) {
        return {
          task: existing,
          created: false,
          conflict:
            "idempotency key is already bound to a different repository, base branch, or task prompt",
        };
      }
      if (existing.branch && existing.branch !== input.branch) {
        return {
          task: existing,
          created: false,
          conflict:
            "idempotency key is already bound to a different repository, branch, base branch, or task prompt",
        };
      }
      if (!existing.branch || !existing.executionMode) {
        const migrated = {
          ...existing,
          branch: existing.branch || input.branch,
          // Records created before Workflow support are Agent records. Keep
          // idempotent retries on the original execution surface.
          executionMode: existing.executionMode ?? "agent",
          updatedAt: Date.now(),
        };
        await this.ctx.storage.put(TASK_KEY, migrated);
        return { task: migrated, created: false };
      }
      return { task: existing, created: false };
    }

    const now = Date.now();
    const task: CodingTaskRecord = {
      ...input,
      executionMode: input.executionMode ?? "agent",
      state: "created",
      createdAt: now,
      updatedAt: now,
    };
    await this.ctx.storage.put(TASK_KEY, task);
    await this.ctx.storage.setAlarm(now + MAX_TASK_LIFETIME_MS);
    return { task, created: true };
  }

  async get(): Promise<CodingTaskRecord | null> {
    return (await this.ctx.storage.get<CodingTaskRecord>(TASK_KEY)) ?? null;
  }

  async markDispatched(input: {
    submissionId?: string;
    streamOffset?: string;
  }): Promise<CodingTaskRecord | null> {
    return this.update((task) => ({
      ...task,
      state:
        task.state === "cancellation_requested" ||
        task.state === "publishing" ||
        task.state === "completed" ||
        task.state === "failed" ||
        task.state === "cancelled"
          ? task.state
          : "dispatched",
      submissionId: input.submissionId,
      streamOffset: input.streamOffset,
    }));
  }

  async bindWorkflowRun(workflowRunId: string): Promise<CodingTaskRecord | null> {
    return this.update((task) => ({ ...task, workflowRunId }));
  }

  /**
   * Atomically reserve the task's GitHub write boundary for one session.
   * Cancellation cannot transition a task after this lease is acquired.
   */
  async beginPublication(sessionId: string): Promise<PublicationClaimResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<CodingTaskRecord>(TASK_KEY);
      const decision = claimPublication(current ?? null, sessionId);
      if (!decision.claimed || decision.task === current || !decision.task) return decision;
      await this.ctx.storage.put(TASK_KEY, decision.task);
      return decision;
    });
  }

  async claimDispatch(): Promise<{
    claimed: boolean;
    task: CodingTaskRecord | null;
  }> {
    const current = await this.ctx.storage.get<CodingTaskRecord>(TASK_KEY);
    if (!current) return { claimed: false, task: null };
    const staleDispatching =
      current.state === "dispatching" && Date.now() - current.updatedAt > 5 * 60 * 1000;
    if (current.state !== "created" && !staleDispatching) {
      return { claimed: false, task: current };
    }
    const task = {
      ...current,
      state: "dispatching" as const,
      updatedAt: Date.now(),
    };
    await this.ctx.storage.put(TASK_KEY, task);
    return { claimed: true, task };
  }

  async releaseDispatch(): Promise<CodingTaskRecord | null> {
    return this.update((task) => {
      if (task.state !== "dispatching") return task;
      return { ...task, state: "created" };
    });
  }

  /**
   * Record a successful publication without ending the Flue run. The workflow
   * must still return a validated result before the domain task is terminal.
   */
  async recordPublication(result: CodingTaskResult): Promise<CodingTaskRecord | null> {
    return this.update((current) => {
      if (current.state === "cancelled" || current.state === "cancellation_requested") {
        return current;
      }
      return {
        ...current,
        state: current.state === "publishing" ? "publishing" : current.state,
        result,
        outcome: "published",
        error: undefined,
      };
    });
  }

  /** Backward-compatible method name for callers compiled against the old Action contract. */
  async markFinalized(result: CodingTaskResult): Promise<CodingTaskRecord | null> {
    return this.recordPublication(result);
  }

  async settleWorkflow(output: CodingTaskWorkflowOutput): Promise<CodingTaskRecord | null> {
    const task = await this.update((current) => settleCodingTaskRecord(current, output));
    if (task?.state === "completed" || task?.state === "failed" || task?.state === "cancelled") {
      await this.releaseAdmission(task.id);
      await this.cleanupSandbox(task);
      await this.ctx.storage.deleteAlarm();
    }
    return task;
  }

  async markTerminal(
    state: Extract<CodingTaskState, "completed" | "failed">,
    summary?: string,
  ): Promise<CodingTaskRecord | null> {
    const task = await this.update((current) => {
      if (current.state === "cancelled") return current;
      if (current.state === "cancellation_requested") {
        return {
          ...current,
          state: "cancelled",
          summary: summary || "Cancellation requested",
        };
      }
      return {
        ...current,
        state,
        outcome: current.result ? "published" : current.outcome,
        summary,
        publicationSessionId: undefined,
        publicationStartedAt: undefined,
      };
    });
    if (task?.state === "completed" || task?.state === "failed" || task?.state === "cancelled") {
      await this.releaseAdmission(task.id);
      await this.cleanupSandbox(task);
      await this.ctx.storage.deleteAlarm();
    }
    return task;
  }

  async markCancelled(summary = "Flue submission aborted"): Promise<CodingTaskRecord | null> {
    const task = await this.update((current) => {
      if (
        current.state === "completed" ||
        current.state === "failed" ||
        current.state === "cancelled" ||
        current.state === "publishing"
      ) {
        return current;
      }
      return { ...current, state: "cancelled", summary };
    });
    if (task?.state === "completed" || task?.state === "failed" || task?.state === "cancelled") {
      await this.releaseAdmission(task.id);
      await this.cleanupSandbox(task);
      await this.ctx.storage.deleteAlarm();
    }
    return task;
  }

  async markFailed(error: string): Promise<CodingTaskRecord | null> {
    const task = await this.update((current) => {
      if (current.state === "cancelled") return current;
      if (current.state === "cancellation_requested") {
        return {
          ...current,
          state: "cancelled",
          summary: current.summary || error,
        };
      }
      return {
        ...current,
        state: "failed",
        error,
        publicationSessionId: undefined,
        publicationStartedAt: undefined,
      };
    });
    if (task) {
      await this.releaseAdmission(task.id);
      await this.cleanupSandbox(task);
      await this.ctx.storage.deleteAlarm();
    }
    return task;
  }

  async alarm(): Promise<void> {
    const task = await this.get();
    if (!task) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") {
      await this.cleanupSandbox(task);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.markFailed("coding task exceeded maximum lifetime");
  }

  async advanceStreamOffset(streamOffset: string): Promise<CodingTaskRecord | null> {
    return this.update((task) => {
      if (task.state !== "dispatched" && task.state !== "cancellation_requested") return task;
      return { ...task, streamOffset };
    });
  }

  async requestCancellation(): Promise<CodingTaskRecord | null> {
    return this.update((task) => {
      if (
        task.state === "completed" ||
        task.state === "failed" ||
        task.state === "cancelled" ||
        task.state === "publishing"
      ) {
        return task;
      }
      return { ...task, state: "cancellation_requested" };
    });
  }

  private async update(
    mutate: (task: CodingTaskRecord) => CodingTaskRecord,
  ): Promise<CodingTaskRecord | null> {
    const task = await this.ctx.storage.get<CodingTaskRecord>(TASK_KEY);
    if (!task) return null;
    const next = { ...mutate(task), updatedAt: Date.now() };
    await this.ctx.storage.put(TASK_KEY, next);
    return next;
  }

  private async releaseAdmission(taskId: string | undefined): Promise<void> {
    const binding = (this.env as Partial<Env>).CONTROL_PLAN_ADMISSION_DO;
    if (!binding || !taskId) return;
    const admission = binding.get(binding.idFromName("global"));
    await admission.release(taskId);
  }

  private async cleanupSandbox(task: CodingTaskRecord): Promise<void> {
    try {
      const sandbox = getSandbox(this.env.Sandbox, `control-plan-${task.sessionId}`, {
        keepAlive: true,
        sleepAfter: SANDBOX_SLEEP_AFTER,
        transport: "rpc",
        enableDefaultSession: false,
        normalizeId: true,
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sandbox.destroy(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("sandbox destroy timed out")),
              SANDBOX_DESTROY_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (error) {
      console.warn("Failed to destroy coding-task sandbox", {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
