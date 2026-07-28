export type TaskLifecycle = {
  terminal: boolean;
  nextAction: "poll" | "respond_to_approval" | "report";
  pollAfterMs?: number;
};

/**
 * Make the asynchronous MCP contract explicit for orchestrators. The durable
 * task state remains the source of truth; this is additive guidance that keeps
 * an upstream model from treating `dispatched` as completed.
 */
export function taskLifecycle(
  state:
    | "created"
    | "dispatching"
    | "dispatched"
    | "publishing"
    | "completed"
    | "failed"
    | "cancellation_requested"
    | "cancelled",
  hasOpenApprovals = false,
): TaskLifecycle {
  if (state === "completed" || state === "failed" || state === "cancelled") {
    return { terminal: true, nextAction: "report" };
  }
  if (hasOpenApprovals) {
    return { terminal: false, nextAction: "respond_to_approval", pollAfterMs: 15_000 };
  }
  return { terminal: false, nextAction: "poll", pollAfterMs: 15_000 };
}

export function taskBranch(taskId: string): string {
  return `control-plan/${taskId.replace(/^task_/, "").slice(0, 16)}`;
}

export function taskIdFromSessionId(sessionId: string): string | null {
  const taskId = sessionId.startsWith("control-plan-task_")
    ? sessionId.slice("control-plan-".length)
    : "";
  return /^task_[a-f0-9]{32}$/.test(taskId) ? taskId : null;
}

export function repositoryParts(repository: string): { owner: string; repo: string } | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  return match ? { owner: match[1], repo: match[2] } : null;
}

export async function codingTaskId(repository: string, idempotencyKey: string): Promise<string> {
  const input = new TextEncoder().encode(`${repository}\u0000${idempotencyKey}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `task_${Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Derive a stable retry key when the upstream has no provider-owned issue ID. */
export async function derivedIdempotencyKey(task: string, baseBranch: string): Promise<string> {
  const normalizedTask = task.replace(/\r\n?/g, "\n").trim();
  const input = new TextEncoder().encode(`${baseBranch}\u0000${normalizedTask}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `auto:${baseBranch}:${Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
