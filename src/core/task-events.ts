import { redactFields, redactString } from "./logger";

export const TASK_EVENT_SCHEMA_VERSION = 1;

export type CodingTaskEventType =
  | "task.created"
  | "task.dispatch.claimed"
  | "task.dispatch.released"
  | "task.workflow.bound"
  | "task.state.changed"
  | "task.publication.started"
  | "task.publication.recorded"
  | "task.approval.requested"
  | "task.approval.resolved"
  | "task.sandbox.recovery"
  | "task.sandbox.command"
  | "task.admission.released"
  | "task.workflow.settled"
  | "task.workflow.reconciliation_failed"
  | "task.error"
  | "task.cancellation.requested"
  | "task.cancelled"
  | "task.sandbox.cleanup_failed";

export type CodingTaskEventStatus =
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface CodingTaskEvent {
  eventId: string;
  schemaVersion: number;
  type: CodingTaskEventType;
  occurredAt: number;
  taskId: string;
  seq: number;
  workflowRunId?: string;
  stepId?: string;
  attempt?: number;
  toolCallId?: string;
  sandboxId?: string;
  sandboxCommandId?: string;
  status?: CodingTaskEventStatus;
  data: Record<string, unknown>;
  redacted: boolean;
  truncated: boolean;
}

export type CodingTaskEventInput = Omit<
  CodingTaskEvent,
  "eventId" | "schemaVersion" | "occurredAt" | "seq" | "redacted" | "truncated"
> & {
  occurredAt?: number;
};

const MAX_DEPTH = 4;
const MAX_OBJECT_KEYS = 40;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 4_000;

export function newTaskEventId(): string {
  return `evt_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function sanitizeTaskEventData(data: Record<string, unknown>): {
  data: Record<string, unknown>;
  redacted: boolean;
  truncated: boolean;
} {
  const redactedData = redactFields(data);
  let truncated = false;
  const bounded = boundValue(redactedData, 0, () => {
    truncated = true;
  });
  return {
    data: (bounded && typeof bounded === "object" && !Array.isArray(bounded)
      ? bounded
      : {}) as Record<string, unknown>,
    redacted: JSON.stringify(redactedData) !== JSON.stringify(data),
    truncated,
  };
}

function boundValue(value: unknown, depth: number, markTruncated: () => void): unknown {
  if (typeof value === "string") {
    const redacted = redactString(value);
    if (redacted.length > MAX_STRING_LENGTH) {
      markTruncated();
      return `${redacted.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
    }
    return redacted;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) {
    markTruncated();
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => boundValue(item, depth + 1, markTruncated));
    if (value.length > MAX_ARRAY_ITEMS) markTruncated();
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const bounded: Record<string, unknown> = {};
    for (const [index, [key, item]] of entries.entries()) {
      if (index >= MAX_OBJECT_KEYS) {
        markTruncated();
        break;
      }
      bounded[key] = boundValue(item, depth + 1, markTruncated);
    }
    return bounded;
  }
  markTruncated();
  return String(value);
}
