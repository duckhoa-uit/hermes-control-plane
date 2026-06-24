export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;
export const MAX_SESSION_RUNTIME_MS = 45 * 60 * 1000; // 45 min
export const MAX_PROVISIONING_TIME_MS = 2 * 60 * 1000; // 2 min
export const OPENCODE_PORT = 4096;

export const WS_TAGS = {
  CLIENT: "client",
  RUNNER: "runner",
} as const;
