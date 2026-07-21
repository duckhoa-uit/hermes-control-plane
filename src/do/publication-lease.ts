import type { CodingTaskRecord } from "./coding-task-do";

export type PublicationClaimResult = {
  claimed: boolean;
  task: CodingTaskRecord | null;
  reason?: "not_publishable" | "owned_by_other_session";
};

export function claimPublication(
  current: CodingTaskRecord | null,
  sessionId: string,
  now = Date.now(),
): PublicationClaimResult {
  if (!current) return { claimed: false, task: null, reason: "not_publishable" };
  if (current.state === "publishing") {
    return current.publicationSessionId === sessionId
      ? { claimed: true, task: current }
      : { claimed: false, task: current, reason: "owned_by_other_session" };
  }
  if (current.state !== "dispatched") {
    return { claimed: false, task: current, reason: "not_publishable" };
  }
  return {
    claimed: true,
    task: {
      ...current,
      state: "publishing",
      publicationSessionId: sessionId,
      publicationStartedAt: now,
      updatedAt: now,
    },
  };
}
