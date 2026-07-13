import { DurableObject } from "cloudflare:workers";

export type CodingTaskState =
  | "created"
  | "dispatching"
  | "dispatched"
  | "completed"
  | "failed"
  | "cancellation_requested";

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
  state: CodingTaskState;
  createdAt: number;
  updatedAt: number;
  replayUrl: string;
  submissionId?: string;
  streamOffset?: string;
  summary?: string;
  error?: string;
  result?: CodingTaskResult;
}

export interface CreateCodingTaskInput {
  id: string;
  sessionId: string;
  repository: string;
  baseBranch: string;
  branch: string;
  task: string;
  replayUrl: string;
}

const TASK_KEY = "task";

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
      if (!existing.branch) {
        const migrated = { ...existing, branch: input.branch, updatedAt: Date.now() };
        await this.ctx.storage.put(TASK_KEY, migrated);
        return { task: migrated, created: false };
      }
      if (existing.branch !== input.branch) {
        return {
          task: existing,
          created: false,
          conflict:
            "idempotency key is already bound to a different repository, branch, base branch, or task prompt",
        };
      }
      return { task: existing, created: false };
    }

    const now = Date.now();
    const task: CodingTaskRecord = {
      ...input,
      state: "created",
      createdAt: now,
      updatedAt: now,
    };
    await this.ctx.storage.put(TASK_KEY, task);
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
      state: task.state === "cancellation_requested" ? task.state : "dispatched",
      submissionId: input.submissionId,
      streamOffset: input.streamOffset,
    }));
  }

  async claimDispatch(): Promise<{ claimed: boolean; task: CodingTaskRecord | null }> {
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

  async markFinalized(result: CodingTaskResult): Promise<CodingTaskRecord | null> {
    const task = await this.update((current) =>
      current.state === "cancellation_requested"
        ? current
        : { ...current, state: "completed", result, error: undefined },
    );
    await this.releaseAdmission(task?.id);
    return task;
  }

  async markTerminal(
    state: Extract<CodingTaskState, "completed" | "failed">,
    summary?: string,
  ): Promise<CodingTaskRecord | null> {
    const task = await this.update((current) => {
      return { ...current, state, summary };
    });
    if (task?.state === "completed" || task?.state === "failed")
      await this.releaseAdmission(task.id);
    return task;
  }

  async markCancelled(summary = "Flue submission aborted"): Promise<CodingTaskRecord | null> {
    const task = await this.update((current) => ({
      ...current,
      state: "cancellation_requested",
      summary,
    }));
    await this.releaseAdmission(task?.id);
    return task;
  }

  async markFailed(error: string): Promise<CodingTaskRecord | null> {
    const task = await this.update((current) => ({ ...current, state: "failed", error }));
    await this.releaseAdmission(task?.id);
    return task;
  }

  async advanceStreamOffset(streamOffset: string): Promise<CodingTaskRecord | null> {
    return this.update((task) => {
      if (task.state !== "dispatched" && task.state !== "cancellation_requested") return task;
      return { ...task, streamOffset };
    });
  }

  async requestCancellation(): Promise<CodingTaskRecord | null> {
    return this.update((task) => {
      if (task.state === "completed" || task.state === "failed") return task;
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
}
