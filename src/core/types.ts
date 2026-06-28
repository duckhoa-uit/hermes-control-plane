// ============================================================
// Hermes Control Plane - Core Type Definitions
// ============================================================

// ---- Session States ----
// Simplified after Flue migration: removed E2B-specific states
// (runner_connecting, ready, stalled). Flue's Pi harness
// transitions directly: created → provisioning → running.

export type SessionStatus =
  | "created"
  | "provisioning"
  | "running"
  | "needs_approval"
  | "review_ready"
  | "creating_pr"
  | "completed"
  | "failed"
  | "aborted"
  | "stalled"
  | "archived";

// ---- Session ----

export interface Session {
  id: string;
  projectId: string;
  taskDescription: string;
  status: SessionStatus;
  branch: string;
  createdAt: number;
  updatedAt: number;
  sandboxId?: string;
  runnerConnected: boolean;
  lastHeartbeat?: number;
  errorMessage?: string;
  pendingPrompt?: string;
  repoInstructions?: string;
  repoInstructionsSource?: "AGENTS.md" | "CLAUDE.md" | "CONVENTIONS.md";
}

// ---- Sandbox Provider Interface ----

export interface CreateSandboxInput {
  sessionId: string;
  runnerToken: string;
  controlWsUrl: string;
  repoUrl: string;
  branch: string;
  setupScript?: string;
  env?: Record<string, string>;
}

export interface SandboxHandle {
  sandboxId: string;
  previewUrl?: string;
  status: "running" | "paused" | "stopped";
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxProvider {
  create(input: CreateSandboxInput): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, command: string): Promise<CommandResult>;
  exposePort(handle: SandboxHandle, port: number): Promise<string>;
  destroy(handle: SandboxHandle): Promise<void>;
}
