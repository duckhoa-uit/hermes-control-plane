// ============================================================
// Session State Machine
// ============================================================

import type { SessionStatus } from "./types";

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  created: ["provisioning", "aborted", "failed"],
  provisioning: ["runner_connecting", "failed", "aborted"],
  runner_connecting: ["ready", "failed", "aborted"],
  ready: ["running", "failed", "aborted"],
  running: ["needs_approval", "review_ready", "stalled", "failed", "completed", "aborted"],
  needs_approval: ["running", "aborted", "failed"],
  review_ready: ["creating_pr", "completed", "aborted"],
  creating_pr: ["completed", "failed"],
  completed: ["archived"],
  failed: ["archived"],
  aborted: ["archived"],
  stalled: ["running", "failed"],
  archived: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: SessionStatus,
    public readonly to: SessionStatus,
  ) {
    super(`Invalid state transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  const allowed = VALID_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function getValidTransitions(from: SessionStatus): SessionStatus[] {
  return VALID_TRANSITIONS[from] ?? [];
}

export const TERMINAL_STATES: SessionStatus[] = ["completed", "failed", "aborted"];
export const ACTIVE_STATES: SessionStatus[] = [
  "provisioning",
  "runner_connecting",
  "ready",
  "running",
  "needs_approval",
  "review_ready",
  "creating_pr",
];

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

export function isActive(status: SessionStatus): boolean {
  return ACTIVE_STATES.includes(status);
}
