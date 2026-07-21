import type { CodingTaskWorkflowOutput } from "./coding-task-contract";
import type { CodingTaskRecord } from "../do/coding-task-do";

/**
 * Apply the finite Workflow result to the task record without touching storage.
 * A publication lease without a durable publication result always fails closed.
 */
export function settleCodingTaskRecord(
  current: CodingTaskRecord,
  output: CodingTaskWorkflowOutput,
): CodingTaskRecord {
  if (current.state === "cancelled") return current;
  if (current.state === "cancellation_requested") {
    return {
      ...current,
      state: "cancelled",
      summary: "Cancellation requested",
    };
  }

  const published = Boolean(current.result) || output.outcome === "published";
  const publicationIncomplete = current.state === "publishing" && !current.result;
  const blocked = !published && (output.outcome === "blocked" || publicationIncomplete);
  const blockedReason = publicationIncomplete
    ? output.blockedReason ||
      "Workflow ended while publication was in progress without a durable result"
    : output.blockedReason;

  return {
    ...current,
    state: blocked ? "failed" : "completed",
    outcome: published ? "published" : publicationIncomplete ? "blocked" : output.outcome,
    summary: publicationIncomplete ? blockedReason : output.summary,
    verification: output.verification,
    blockedReason,
    error: blocked ? blockedReason || output.summary : undefined,
    publicationSessionId: undefined,
    publicationStartedAt: undefined,
  };
}
