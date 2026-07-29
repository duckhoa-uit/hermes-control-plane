import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import { claimPublication, type PublicationClaimResult } from "./publication-lease";
import type { CodingTaskWorkflowOutput } from "../core/coding-task-contract";
import { settleCodingTaskRecord } from "../core/coding-task-settlement";
import { createLogger } from "../core/logger";
import { getWorkerTracing, withCustomSpan } from "../core/tracing";
import {
  TASK_EVENT_SCHEMA_VERSION,
  type CodingTaskEvent,
  type CodingTaskEventInput,
  newTaskEventId,
  sanitizeTaskEventData,
} from "../core/task-events";

export type CodingTaskState =
  | "created"
  | "dispatching"
  | "dispatched"
  | "publishing"
  | "completed"
  | "failed"
  | "cancellation_requested"
  | "cancelled";

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
  eventSeq?: number;
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
}

const TASK_SNAPSHOT_KEY = "task";
const MAX_TASK_LIFETIME_MS = 3 * 60 * 60 * 1000;
const SANDBOX_SLEEP_AFTER = "5m";
const SANDBOX_DESTROY_TIMEOUT_MS = 15_000;

// The class is the coding-job domain record; Flue owns workflow orchestration.
export class ControlPlanTaskDurableObject extends DurableObject<Env> {
  private readonly logger = createLogger({ service: "control-plan.task" });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initSchema();
  }

  private initSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS task_snapshot (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS task_events (
        seq INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        workflow_run_id TEXT,
        step_id TEXT,
        attempt INTEGER,
        tool_call_id TEXT,
        sandbox_id TEXT,
        sandbox_command_id TEXT,
        status TEXT,
        data_json TEXT NOT NULL,
        redacted INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_task_events_type ON task_events(type, seq);",
    );
  }

  private appendEvent(input: CodingTaskEventInput): CodingTaskEvent {
    const sanitized = sanitizeTaskEventData(input.data);
    const eventId = newTaskEventId();
    const occurredAt = input.occurredAt ?? Date.now();
    const row = this.ctx.storage.sql
      .exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_events")
      .one();
    const event: CodingTaskEvent = {
      ...input,
      eventId,
      schemaVersion: TASK_EVENT_SCHEMA_VERSION,
      occurredAt,
      seq: row.seq,
      data: sanitized.data,
      redacted: sanitized.redacted,
      truncated: sanitized.truncated,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO task_events
       (seq, event_id, schema_version, type, occurred_at, task_id, workflow_run_id,
        step_id, attempt, tool_call_id, sandbox_id, sandbox_command_id, status,
        data_json, redacted, truncated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.seq,
      event.eventId,
      event.schemaVersion,
      event.type,
      event.occurredAt,
      event.taskId,
      event.workflowRunId ?? null,
      event.stepId ?? null,
      event.attempt ?? null,
      event.toolCallId ?? null,
      event.sandboxId ?? null,
      event.sandboxCommandId ?? null,
      event.status ?? null,
      JSON.stringify(event.data),
      event.redacted ? 1 : 0,
      event.truncated ? 1 : 0,
    );
    this.logger.info("task event appended", {
      event: event.type,
      taskId: event.taskId,
      seq: event.seq,
      status: event.status,
      workflowRunId: event.workflowRunId,
      stepId: event.stepId,
      attempt: event.attempt,
      sandboxCommandId: event.sandboxCommandId,
    });
    return event;
  }

  private readEvents(afterSeq = 0, limit = 100): CodingTaskEvent[] {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), 500)
      : 100;
    const rows = this.ctx.storage.sql
      .exec<{
        seq: number;
        event_id: string;
        schema_version: number;
        type: CodingTaskEvent["type"];
        occurred_at: number;
        task_id: string;
        workflow_run_id: string | null;
        step_id: string | null;
        attempt: number | null;
        tool_call_id: string | null;
        sandbox_id: string | null;
        sandbox_command_id: string | null;
        status: string | null;
        data_json: string;
        redacted: number;
        truncated: number;
      }>(
        `SELECT * FROM task_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
        Math.max(0, afterSeq),
        boundedLimit,
      )
      .toArray();
    return rows.map((row) => ({
      eventId: row.event_id,
      schemaVersion: row.schema_version,
      type: row.type,
      occurredAt: row.occurred_at,
      taskId: row.task_id,
      seq: row.seq,
      workflowRunId: row.workflow_run_id ?? undefined,
      stepId: row.step_id ?? undefined,
      attempt: row.attempt ?? undefined,
      toolCallId: row.tool_call_id ?? undefined,
      sandboxId: row.sandbox_id ?? undefined,
      sandboxCommandId: row.sandbox_command_id ?? undefined,
      status: isEventStatus(row.status) ? row.status : undefined,
      data: safeJsonObject(row.data_json),
      redacted: row.redacted === 1,
      truncated: row.truncated === 1,
    }));
  }

  async events(afterSeq = 0, limit = 100): Promise<{ events: CodingTaskEvent[]; nextSeq: number }> {
    const normalizedAfterSeq =
      Number.isFinite(afterSeq) && afterSeq >= 0 ? Math.trunc(afterSeq) : 0;
    const events = this.readEvents(normalizedAfterSeq, limit);
    return { events, nextSeq: events.at(-1)?.seq ?? afterSeq };
  }

  async getEvents(
    afterSeq = 0,
    limit = 100,
  ): Promise<{ events: CodingTaskEvent[]; nextSeq: number }> {
    return this.events(afterSeq, limit);
  }

  async recordSandboxEvent(data: Record<string, unknown>): Promise<void> {
    const task = this.readSnapshot();
    if (!task) return;
    this.appendStateEvent(task, "task.sandbox.recovery", data, "progress");
  }

  private appendStateEvent(
    task: CodingTaskRecord,
    type: CodingTaskEventInput["type"],
    data: Record<string, unknown>,
    status?: CodingTaskEventInput["status"],
  ): CodingTaskEvent {
    return this.appendEvent({
      type,
      taskId: task.id,
      workflowRunId: task.workflowRunId,
      status,
      data,
    });
  }
  async create(
    input: CreateCodingTaskInput,
  ): Promise<{ task: CodingTaskRecord; created: boolean; conflict?: string }> {
    const existing = this.readSnapshot();
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
    this.ctx.storage.transactionSync(() => {
      const event = this.appendStateEvent(
        task,
        "task.created",
        {
          repository: task.repository,
          baseBranch: task.baseBranch,
          branch: task.branch,
        },
        "completed",
      );
      task.eventSeq = event.seq;
      this.writeSnapshot(task);
    });
    await this.ctx.storage.setAlarm(now + MAX_TASK_LIFETIME_MS);
    return { task, created: true };
  }

  async get(): Promise<CodingTaskRecord | null> {
    return this.readSnapshot();
  }

  async markDispatched(): Promise<CodingTaskRecord | null> {
    return this.update(
      (task) => ({
        ...task,
        state:
          task.state === "cancellation_requested" ||
          task.state === "publishing" ||
          task.state === "completed" ||
          task.state === "failed" ||
          task.state === "cancelled"
            ? task.state
            : "dispatched",
      }),
      "task.state.changed",
    );
  }

  async bindWorkflowRun(workflowRunId: string): Promise<CodingTaskRecord | null> {
    return this.update((task) => ({ ...task, workflowRunId }), "task.workflow.bound", {
      workflowRunId,
    });
  }

  /**
   * Atomically reserve the task's GitHub write boundary for one session.
   * Cancellation cannot transition a task after this lease is acquired.
   */
  async beginPublication(sessionId: string): Promise<PublicationClaimResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = this.readSnapshot();
      const decision = claimPublication(current ?? null, sessionId);
      if (!decision.claimed || decision.task === current || !decision.task) return decision;
      this.ctx.storage.transactionSync(() => {
        const event = this.appendStateEvent(
          decision.task!,
          "task.publication.started",
          { publicationSessionId: sessionId },
          "started",
        );
        decision.task!.eventSeq = event.seq;
        this.writeSnapshot(decision.task!);
      });
      return decision;
    });
  }

  async claimDispatch(): Promise<{
    claimed: boolean;
    task: CodingTaskRecord | null;
  }> {
    const current = this.readSnapshot();
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
    this.ctx.storage.transactionSync(() => {
      const event = this.appendStateEvent(
        task,
        "task.dispatch.claimed",
        { previousState: current.state, state: task.state },
        "started",
      );
      task.eventSeq = event.seq;
      this.writeSnapshot(task);
    });
    return { claimed: true, task };
  }

  async releaseDispatch(): Promise<CodingTaskRecord | null> {
    return this.update((task) => {
      if (task.state !== "dispatching") return task;
      return { ...task, state: "created" };
    }, "task.dispatch.released");
  }

  /**
   * Record a successful publication without ending the Flue run. The workflow
   * must still return a validated result before the domain task is terminal.
   */
  async recordPublication(result: CodingTaskResult): Promise<CodingTaskRecord | null> {
    return this.update(
      (current) => {
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
      },
      "task.publication.recorded",
      { result },
    );
  }

  async settleWorkflow(output: CodingTaskWorkflowOutput): Promise<CodingTaskRecord | null> {
    const existingTask = this.readSnapshot();
    if (
      existingTask &&
      (existingTask.state === "completed" ||
        existingTask.state === "failed" ||
        existingTask.state === "cancelled")
    ) {
      return existingTask;
    }
    const task = await this.update(
      (storedTask) => settleCodingTaskRecord(storedTask, output),
      "task.workflow.settled",
      { outcome: output.outcome },
    );
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
    const task = await this.update(
      (current) => {
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
      },
      "task.state.changed",
      { summary, requestedState: state },
    );
    if (task?.state === "completed" || task?.state === "failed" || task?.state === "cancelled") {
      await this.releaseAdmission(task.id);
      await this.cleanupSandbox(task);
      await this.ctx.storage.deleteAlarm();
    }
    return task;
  }

  async markCancelled(
    summary = "Workflow cancellation requested",
  ): Promise<CodingTaskRecord | null> {
    const task = await this.update(
      (current) => {
        if (
          current.state === "completed" ||
          current.state === "failed" ||
          current.state === "cancelled" ||
          current.state === "publishing"
        ) {
          return current;
        }
        return { ...current, state: "cancelled", summary };
      },
      "task.cancelled",
      { summary },
    );
    if (task?.state === "completed" || task?.state === "failed" || task?.state === "cancelled") {
      await this.releaseAdmission(task.id);
      await this.cleanupSandbox(task);
      await this.ctx.storage.deleteAlarm();
    }
    return task;
  }

  async markFailed(error: string): Promise<CodingTaskRecord | null> {
    const task = await this.update(
      (current) => {
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
      },
      "task.error",
      { error },
    );
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
    }, "task.cancellation.requested");
  }

  private async update(
    mutate: (task: CodingTaskRecord) => CodingTaskRecord,
    eventType: CodingTaskEventInput["type"] = "task.state.changed",
    eventData: Record<string, unknown> = {},
  ): Promise<CodingTaskRecord | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const task = this.readSnapshot();
      if (!task) return null;
      const next = { ...mutate(task), updatedAt: Date.now() };
      const changed = next.state !== task.state;
      this.ctx.storage.transactionSync(() => {
        const event = this.appendStateEvent(
          next,
          eventType,
          {
            previousState: task.state,
            state: next.state,
            ...eventData,
          },
          changed ? stateEventStatus(next.state) : undefined,
        );
        next.eventSeq = event.seq;
        this.writeSnapshot(next);
      });
      return next;
    });
  }

  private readSnapshot(): CodingTaskRecord | null {
    const row = this.ctx.storage.sql
      .exec<{ payload_json: string }>(
        "SELECT payload_json FROM task_snapshot WHERE id = ?",
        TASK_SNAPSHOT_KEY,
      )
      .toArray()[0];
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as CodingTaskRecord;
    } catch {
      return null;
    }
  }

  private writeSnapshot(task: CodingTaskRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO task_snapshot (id, payload_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
      TASK_SNAPSHOT_KEY,
      JSON.stringify(task),
      task.updatedAt,
    );
  }

  private async releaseAdmission(taskId: string | undefined): Promise<void> {
    const binding = (this.env as Partial<Env>).CONTROL_PLAN_ADMISSION_DO;
    if (!binding || !taskId) return;
    const admission = binding.get(binding.idFromName("global"));
    await withCustomSpan(
      await getWorkerTracing(),
      "control_plan.admission.release",
      { "control_plan.task_id": taskId },
      () => admission.release(taskId),
    );
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
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("failed to destroy coding-task sandbox", {
        event: "task.sandbox.cleanup_failed",
        taskId: task.id,
        sessionId: task.sessionId,
        workflowRunId: task.workflowRunId,
        error: message,
      });
      this.appendStateEvent(task, "task.sandbox.cleanup_failed", { error: message }, "failed");
    }
  }
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isEventStatus(value: string | null): value is NonNullable<CodingTaskEvent["status"]> {
  return [
    "started",
    "progress",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted",
  ].includes(value ?? "");
}

function stateEventStatus(state: CodingTaskState): CodingTaskEventInput["status"] | undefined {
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  return undefined;
}
