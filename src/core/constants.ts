export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 15 * 60_000; // 15 min — long enough that E2B's onTimeout=15min pause doesn't get mistakenly flagged as a dead runner; short enough that a real runner crash is detected before the 35-min launcher hard deadline. Codex picks 10min; OpenHands picks none (LRU). 15min splits the middle.
export const MAX_SESSION_RUNTIME_MS = 45 * 60 * 1000; // 45 min
export const MAX_PROVISIONING_TIME_MS = 2 * 60 * 1000; // 2 min
export const OPENCODE_PORT = 4096;

export const WS_TAGS = {
  CLIENT: "client",
  RUNNER: "runner",
} as const;
