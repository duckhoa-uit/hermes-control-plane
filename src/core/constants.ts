export const HEARTBEAT_INTERVAL_MS = 15_000;

// If no heartbeat seen for this long, assume sandbox is paused.
// Runner heartbeats every 10s; 45s = ~4 missed beats. Distinct from
// HEARTBEAT_TIMEOUT_MS (15min) which is a "real stall" signal.
export const PAUSED_HEARTBEAT_THRESHOLD_MS = 45_000;

// 15 min — determines when to mark stalled sessions
export const HEARTBEAT_TIMEOUT_MS = 15 * 60_000;

// Currently unused (no runner heartbeat since Flue Pi runs in DO)
// Kept for observability if needed later.

export const WS_TAGS = {
  CLIENT: "client",
  RUNNER: "runner",
} as const;
