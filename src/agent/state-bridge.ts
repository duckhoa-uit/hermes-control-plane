// ============================================================
// State Bridge: Hermes state machine ↔ Flue agent lifecycle
// ============================================================
// Flue's Pi lifecycle maps directly to Hermes SessionStatus:
//
//   created    → created
//   submitted  → provisioning
//   running    → running
//   needs_input → needs_approval
//   completed  → completed
//   failed     → failed
//   aborted    → aborted
//
// Most transitions are direct (no intermediate E2B states).

import type { SessionStatus } from "../core/types";
import { assertTransition, isTerminal } from "../core/state-machine";

export type AgentLifecycle =
  | "created"
  | "submitted"
  | "running"
  | "needs_input"
  | "completed"
  | "failed"
  | "aborted";

export function lifecycleToStatus(lifecycle: AgentLifecycle): SessionStatus {
  switch (lifecycle) {
    case "created":
      return "created";
    case "submitted":
      return "provisioning";
    case "running":
      return "running";
    case "needs_input":
      return "needs_approval";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
  }
}

export function advanceStatus(current: SessionStatus, next: SessionStatus): SessionStatus {
  assertTransition(current, next);
  return next;
}

/**
 * Apply a lifecycle event and compute resulting Hermes status.
 * Flue's Pi lifecycle is simpler than the old architecture:
 * - provisioning → running is direct (no runner_connecting/ready)
 * - Follow-up submission while running stays running
 * - Terminal completed archives the session
 */
export function applyLifecycleEvent(current: SessionStatus, event: AgentLifecycle): SessionStatus {
  const target = lifecycleToStatus(event);

  // Follow-up submission while still running
  if (current === "running" && event === "submitted") {
    return "running";
  }

  // Review loop: agent gets follow-up while review_ready
  if (current === "review_ready" && event === "running") {
    return "running";
  }

  // Terminal completed → archived
  if (isTerminal(current) && target === "completed") {
    assertTransition(current, "archived");
    return "archived";
  }

  // Standard transition
  assertTransition(current, target);
  return target;
}
