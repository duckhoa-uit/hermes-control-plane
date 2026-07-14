export type AgentEvent = {
  type?: string;
  isError?: boolean;
  outcome?: string;
  error?: { message?: string };
  response?: { error?: { message?: string } };
  message?: { role?: string; content?: unknown };
};

export type AgentHistory = {
  offset?: string;
  settlements?: Array<{
    submissionId?: string;
    outcome?: string;
    result?: { text?: string };
  }>;
};

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
    | "completed"
    | "failed"
    | "cancellation_requested",
  hasOpenApprovals = false,
): TaskLifecycle {
  if (state === "completed" || state === "failed") {
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

/**
 * Derive a stable retry key when the upstream orchestrator does not have a
 * provider-owned issue ID. Keep this deterministic: a random LLM-generated
 * value would defeat idempotency and could dispatch duplicate coding agents.
 */
export async function derivedIdempotencyKey(task: string, baseBranch: string): Promise<string> {
  const normalizedTask = task.replace(/\r\n?/g, "\n").trim();
  const input = new TextEncoder().encode(`${baseBranch}\u0000${normalizedTask}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `auto:${baseBranch}:${Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function taskStateFromEvents(events: AgentEvent[]): {
  state?: "completed" | "failed";
  summary?: string;
} {
  const failed = events.find(
    (event) =>
      (event.type === "submission_settled" && event.outcome === "failed") ||
      (event.type === "turn" && event.isError),
  );
  if (failed) {
    return {
      state: "failed",
      summary: failed.response?.error?.message || failed.error?.message || "Agent execution failed",
    };
  }

  if (events.some((event) => event.type === "idle" || event.type === "agent_end")) {
    const completedMessage = events
      .toReversed()
      .find((event) => event.type === "message_end" && event.message?.role === "assistant");
    return { state: "completed", summary: textContent(completedMessage?.message?.content) };
  }

  return {};
}

export function taskStateFromHistory(
  history: AgentHistory,
  submissionId?: string,
): { state?: "completed" | "failed" | "aborted"; summary?: string; offset?: string } {
  const settlement = history.settlements?.find(
    (candidate) => !submissionId || candidate.submissionId === submissionId,
  );
  if (!settlement) return { offset: history.offset };
  if (settlement.outcome === "completed") {
    return { state: "completed", summary: settlement.result?.text, offset: history.offset };
  }
  if (settlement.outcome === "aborted") {
    return { state: "aborted", summary: "Flue submission aborted", offset: history.offset };
  }
  if (settlement.outcome === "failed") {
    return { state: "failed", summary: "Flue submission failed", offset: history.offset };
  }
  return { offset: history.offset };
}

function textContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return (
    content
      .filter(
        (part): part is { type?: string; text?: string } =>
          typeof part === "object" && part !== null,
      )
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n") || undefined
  );
}
