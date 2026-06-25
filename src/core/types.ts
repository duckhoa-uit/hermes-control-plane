// ============================================================
// Hermes Control Plane - Core Type Definitions
// ============================================================

// ---- Session States ----

export type SessionStatus =
  | "created"
  | "provisioning"
  | "runner_connecting"
  | "ready"
  | "running"
  | "needs_approval"
  | "review_ready"
  | "creating_pr"
  | "completed"
  | "failed"
  | "aborted"
  | "stalled"
  | "archived";

// ---- Project Profile ----

export interface ApprovalPolicy {
  autoAllow: string[];
  requireApproval: string[];
}

export interface ProjectProfile {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  setupScript?: string;
  testScript?: string;
  agentsContext?: string;
  model: string;
  allowedTools: string[];
  approvalPolicy: ApprovalPolicy;
  env?: Record<string, string>;
}

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
  // M5: single-slot follow-up prompt queue. POST /prompt while runner
  // disconnected stores the prompt here + asks launcher to resume; on
  // runner.connected we flush it as an agent.prompt command.
  pendingPrompt?: string;
}

// ---- Events (append-only log) ----

export type EventSource = "user" | "runner" | "opencode" | "system";

export interface HermesEvent {
  id: string;
  sessionId: string;
  seq: number;
  type: HermesEventType;
  source: EventSource;
  payload: Record<string, unknown>;
  createdAt: number;
}

export type HermesEventType =
  | "session.created"
  | "session.status_changed"
  | "session.completed"
  | "session.failed"
  | "sandbox.provisioning"
  | "sandbox.ready"
  | "sandbox.destroyed"
  | "runner.connected"
  | "runner.disconnected"
  | "runner.heartbeat"
  | "agent.message.delta"
  | "agent.message.complete"
  | "agent.started"
  | "agent.done"
  | "agent.error"
  | "tool.started"
  | "tool.output"
  | "tool.completed"
  | "file.changed"
  | "approval.requested"
  | "approval.resolved"
  | "git.diff.ready"
  | "git.branch.pushed"
  | "pr.created"
  | "pr.merged"
  | "pr.closed"
  | "system.stalled"
  | "system.retrying"
  | "agent.usage";

// ---- Runner Commands (control plane -> runner) ----

export type RunnerCommandType =
  | "agent.prompt"
  | "agent.abort"
  | "approval.grant"
  | "approval.deny"
  | "shell.exec"
  | "git.diff"
  | "pr.create"
  | "session.shutdown";

export interface RunnerCommand {
  commandId: string;
  type: RunnerCommandType;
  payload: Record<string, unknown>;
  createdAt: number;
}

// ---- Runner Messages (runner -> control plane) ----

export type RunnerMessageType =
  | "runner.connect"
  | "runner.heartbeat"
  | "runner.event"
  | "runner.command_ack"
  | "runner.command_error"
  | "runner.complete"
  | "runner.error";

export interface RunnerMessage {
  type: RunnerMessageType;
  sessionId: string;
  payload?: Record<string, unknown>;
}

// ---- Client Messages (UI -> control plane) ----

export type ClientMessageType =
  | "client.subscribe"
  | "client.unsubscribe"
  | "client.approve"
  | "client.deny"
  | "client.abort"
  | "client.create_pr";

export interface ClientMessage {
  type: ClientMessageType;
  payload?: Record<string, unknown>;
}

// ---- Artifacts ----

export interface SessionArtifacts {
  sessionId: string;
  summary?: string;
  diff?: string;
  changedFiles: string[];
  testResult?: TestResult;
  prUrl?: string;
  logsUrl?: string;
}

export interface TestResult {
  passed: boolean;
  total: number;
  failed: number;
  output: string;
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
