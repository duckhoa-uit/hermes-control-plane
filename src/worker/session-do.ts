// ============================================================
// SessionDurableObject - one per agent session
// Owns: state machine, event log, WS hub, approval gates,
//       heartbeat/stall detection, command dispatch
// ============================================================

import { DurableObject } from "cloudflare:workers";
import type {
  Session,
  SessionStatus,
  HermesEvent,
  HermesEventType,
  EventSource,
  RunnerCommand,
  RunnerMessage,
  ClientMessage,
  ProjectProfile,
  SessionArtifacts,
} from "../core/types";
import { EventLog } from "../core/event-log";
import { getPrIndexStub, prKeyFromUrl } from "./pr-index-do";
import { canTransition, isTerminal } from "../core/state-machine";
import { generateCommandId, generateRunnerToken, generateRequestId } from "../core/id";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, PAUSED_HEARTBEAT_THRESHOLD_MS, WS_TAGS } from "../core/constants";

// Zero-padded so storage.list({ prefix: "evt:" }) returns events in seq order.
const eventKey = (seq: number) => `evt:${seq.toString().padStart(10, "0")}`;

// Per-WebSocket metadata that survives DO hibernation. Persisted via
// ws.serializeAttachment() in handleClientWS / handleRunnerWS so the
// hibernation API can wake us with the WS state intact.
type WSAttachment = {
  tag: typeof WS_TAGS.CLIENT | typeof WS_TAGS.RUNNER;
  lastSeq: number;
};

export class SessionDurableObject extends DurableObject<CloudflareEnv> {
  private session: Session | null = null;
  private profile: ProjectProfile | null = null;
  private eventLog = new EventLog();
  private runnerToken: string | null = null;
  private pendingApprovals = new Map<string, { action: string; commandId: string }>();
  private artifacts: SessionArtifacts | null = null;
  private controlBaseUrl: string | null = null;

  // ---- WebSocket accessors (hibernation-safe) ----
  // ctx.getWebSockets(tag) is the canonical source of truth — survives
  // hibernation, no in-memory bookkeeping needed.

  private getRunnerWS(): WebSocket | null {
    return this.ctx.getWebSockets(WS_TAGS.RUNNER)[0] ?? null;
  }

  private getAllWebSockets(): WebSocket[] {
    return this.ctx.getWebSockets();
  }

  private readAttachment(ws: WebSocket): WSAttachment {
    return (ws.deserializeAttachment() as WSAttachment | null) ?? {
      tag: WS_TAGS.CLIENT,
      lastSeq: -1,
    };
  }

  private writeAttachment(ws: WebSocket, patch: Partial<WSAttachment>): void {
    const current = this.readAttachment(ws);
    ws.serializeAttachment({ ...current, ...patch });
  }

  // ---- Lifecycle ----

  async init(
    profile: ProjectProfile,
    taskDescription: string,
    controlBaseUrl: string,
    amendPrUrl?: string,
    branchSuffix?: string,
  ): Promise<Session> {
    // Skill: durable-objects/gotchas "Race Condition Despite Single-Threading".
    // The mutate-then-persist sequence has an await point, so block any
    // concurrent init() to make the double-create check + persist atomic.
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.session) {
        throw new Error(`Session already initialized: ${this.session.id}`);
      }

      const sessionId = this.ctx.id.toString();
      const now = Date.now();

      this.session = {
        id: sessionId,
        projectId: profile.id,
        taskDescription,
        status: "created",
        // A1: optional suggested suffix (validated /^[a-z0-9-]{1,40}$/)
        // makes branch readable in the GitHub branch picker. Invalid /
        // missing → fall back to today's hermes/<id8>. Must stay in sync
        // with src/launcher/provision.ts.
        branch: (() => {
          const s = branchSuffix && /^[a-z0-9-]{1,40}$/.test(branchSuffix)
            ? branchSuffix
            : "";
          return s ? `hermes/${s}-${sessionId.slice(-4)}` : `hermes/${sessionId.slice(-8)}`;
        })(),
        createdAt: now,
        updatedAt: now,
        runnerConnected: false,
      };
      this.profile = profile;
      this.runnerToken = generateRunnerToken();
      this.controlBaseUrl = controlBaseUrl;
      // Amend mode pre-population: store the existing PR URL on artifacts
      // immediately so the transition() slot-release hook can identify
      // the PR even if the session aborts before pr.updated fires.
      if (amendPrUrl) {
        this.artifacts = { sessionId, prUrl: amendPrUrl, changedFiles: [] };
      }

      this.appendEvent("session.created", "system", { taskDescription, projectId: profile.id, amendPrUrl });
      await this.persist();

      // Kick off sandbox provisioning in the background. The HTTP response
      // returns immediately; status will advance via events as the sandbox
      // boots and the runner connects back over WebSocket.
      this.ctx.waitUntil(this.provisionSandbox());

      return this.session;
    });
  }

  // ---- Sandbox lifecycle ----

  private async provisionSandbox(): Promise<void> {
    if (!this.session || !this.profile || !this.runnerToken || !this.controlBaseUrl) return;
    if (!this.profile.repoUrl) {
      // Nothing to clone; skip provisioning and let an external runner
      // (e.g. fake-runner used in tests) connect on its own.
      return;
    }
    if (!this.env.E2B_API_KEY) {
      // Fail fast on misconfigured deployments. The Worker does not drive
      // real sandbox creation (workerd kills the E2B SDK) — it just gates
      // on the secret being present. The host-side launcher
      // (scripts/launch-session.ts) is the one that calls Sandbox.create()
      // and drops /opt/control-plane/start.json.
      const msg =
        "E2B_API_KEY is not configured on the Worker. Set it with `wrangler secret put E2B_API_KEY` before starting a coding session.";
      console.error("[DO] sandbox provisioning blocked:", msg);
      this.appendEvent("agent.error", "system", { error: msg });
      if (canTransition(this.session.status, "failed")) {
        this.transition("failed", msg);
      }
      return;
    }
    // Real provider runs host-side (see scripts/launch-session.ts).
    // The Worker just announces the session is awaiting a runner.
    this.appendEvent("sandbox.provisioning", "system", {
      template: this.env.E2B_TEMPLATE ?? "control-plane-runner",
      mode: "external",
    });
    if (canTransition(this.session.status, "provisioning")) {
      this.transition("provisioning");
    }
  }

  getSession(): Session | null {
    return this.session;
  }

  getRunnerToken(): string | null {
    return this.runnerToken;
  }

  getEvents(sinceSeq?: number): HermesEvent[] {
    return sinceSeq !== undefined
      ? this.eventLog.getSince(sinceSeq)
      : this.eventLog.getAll();
  }

  getArtifacts(): SessionArtifacts | null {
    return this.artifacts;
  }

  // ---- State transitions ----

  private transition(to: SessionStatus, errorMsg?: string): void {
    if (!this.session) throw new Error("Session not initialized");

    if (!canTransition(this.session.status, to)) {
      throw new Error(`Invalid transition: ${this.session.status} -> ${to}`);
    }

    const from = this.session.status;
    this.session.status = to;
    this.session.updatedAt = Date.now();
    if (errorMsg) this.session.errorMessage = errorMsg;

    this.appendEvent("session.status_changed", "system", { from, to, error: errorMsg });
    // Persist the session row so a hibernated/restored DO sees the new
    // status. Without this, `restore()` reads the stale `created` row even
    // though the event log shows we are completed/archived — the MCP
    // follow-up flow then mis-classifies the session as live. Fire-and-
    // forget via waitUntil so transition() stays sync for the existing
    // callers.
    this.ctx.waitUntil(this.persist());

    // Release the PR_INDEX_DO single-flight slot if this is an auto-amend
    // session reaching a terminal state. Idempotent + only releases when
    // the inflight sessionId matches, so non-amend sessions are a no-op
    // (cheap RPC call; could be skipped, but skipping requires knowing
    // whether we are an amend session which we do not track on Session).
    if (
      (to === "completed" || to === "failed" || to === "aborted" || to === "archived") &&
      this.artifacts?.prUrl
    ) {
      const sessionId = this.session.id;
      const prUrl = this.artifacts.prUrl;
      this.ctx.waitUntil((async () => {
        try {
          const prKey = prKeyFromUrl(prUrl);
          const stub = getPrIndexStub(this.env);
          await (stub as unknown as {
            releaseAmendSlot(k: string, s: string): Promise<void>;
          }).releaseAmendSlot(prKey, sessionId);
        } catch (err) {
          console.error(`[DO] releaseAmendSlot failed: ${(err as Error).message}`);
        }
      })());
    }
  }

  // ---- Event log ----

  private appendEvent(
    type: HermesEventType,
    source: EventSource,
    payload: Record<string, unknown> = {},
  ): HermesEvent {
    if (!this.session) throw new Error("Session not initialized");
    const event = this.eventLog.append(this.session.id, type, source, payload);
    this.broadcastEvent(event);
    // Persist just this event (per-key) instead of rewriting the whole array.
    // Skill: durable-objects/patterns — append-only event log on SQLite-backed DOs.
    // Key is zero-padded so list({ prefix }) returns events in seq order.
    this.ctx.waitUntil(
      this.ctx.storage.put(eventKey(event.seq), event),
    );
    return event;
  }

  private broadcastEvent(event: HermesEvent): void {
    const msg = JSON.stringify({ type: "event", event });
    for (const ws of this.getAllWebSockets()) {
      const att = this.readAttachment(ws);
      if (att.lastSeq < event.seq) {
        try {
          ws.send(msg);
          this.writeAttachment(ws, { lastSeq: event.seq });
        } catch {
          // The runtime will fire webSocketClose on the next tick; nothing
          // to do here — ctx.getWebSockets() will stop returning it then.
        }
      }
    }
  }

  // ---- WebSocket: Client ----

  async handleClientWS(ws: WebSocket): Promise<void> {
    // Hibernation API: DO can sleep while this WS stays open.
    // Inbound messages/closes are delivered via webSocketMessage / webSocketClose
    // overrides below (skill: workers/gotchas "WebSocket connection closes
    // unexpectedly").
    this.ctx.acceptWebSocket(ws, [WS_TAGS.CLIENT]);
    ws.serializeAttachment({ tag: WS_TAGS.CLIENT, lastSeq: -1 } satisfies WSAttachment);

    // Replay events to new client
    const replay = this.eventLog.getAll();
    if (replay.length > 0) {
      ws.send(JSON.stringify({ type: "replay", events: replay }));
      this.writeAttachment(ws, { lastSeq: this.eventLog.getLatestSeq() });
    }

    ws.send(JSON.stringify({ type: "session_state", session: this.session }));
  }

  // ---- WebSocket: Runner ----

  async handleRunnerWS(ws: WebSocket, token: string): Promise<void> {
    if (token !== this.runnerToken) {
      this.ctx.acceptWebSocket(ws);
      ws.close(4001, "Invalid runner token");
      return;
    }
    if (!this.session) {
      this.ctx.acceptWebSocket(ws);
      ws.close(4002, "Session not found");
      return;
    }

    this.ctx.acceptWebSocket(ws, [WS_TAGS.RUNNER]);
    ws.serializeAttachment({ tag: WS_TAGS.RUNNER, lastSeq: -1 } satisfies WSAttachment);

    this.session.runnerConnected = true;
    this.session.lastHeartbeat = Date.now();

    // If provisioning never started (e.g. fake-runner used directly without
    // a configured repo), fast-forward through provisioning so the state
    // machine can reach `running`.
    if (this.session.status === "created") {
      this.transition("provisioning");
      this.appendEvent("sandbox.provisioning", "system", { sandboxId: "external" });
      this.appendEvent("sandbox.ready", "system", { sandboxId: "external" });
    }

    if (canTransition(this.session.status, "runner_connecting")) {
      this.transition("runner_connecting");
    }

    this.appendEvent("runner.connected", "runner");
    this.startHeartbeatCheck();

    // Runner connected -> ready -> send initial prompt
    if (this.session.status === "runner_connecting") {
      this.transition("ready");
      this.sendInitialPrompt();
    }

    // M5: if a follow-up prompt was queued while the runner was
    // disconnected (sandbox paused), drain it now.
    if (this.session.pendingPrompt) {
      const queued = this.session.pendingPrompt;
      this.session.pendingPrompt = undefined;
      void this.persist();
      if (this.session.status === "review_ready") {
        this.transition("running");
      }
      this.sendRunnerCommand("agent.prompt", {
        taskDescription: queued,
        context: queued,
        model: this.profile?.model ?? "",
        allowedTools: this.profile?.allowedTools ?? [],
      });
    }
  }

  // ---- Client message handling ----

  private handleClientMessage(_ws: WebSocket, data: string | ArrayBuffer): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }

    switch (msg.type) {
      case "client.subscribe":
        break;
      case "client.approve":
        this.handleApproval(true, msg.payload);
        break;
      case "client.deny":
        this.handleApproval(false, msg.payload);
        break;
      case "client.abort":
        this.handleAbort();
        break;
      case "client.create_pr":
        this.handleCreatePR();
        break;
    }
  }

  private handleApproval(approved: boolean, payload?: Record<string, unknown>): void {
    const requestId = payload?.requestId as string;
    if (!requestId) return;

    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;

    this.pendingApprovals.delete(requestId);
    this.appendEvent("approval.resolved", "user", { requestId, approved });

    if (this.session?.status === "needs_approval") {
      this.transition("running");
    }

    this.sendRunnerCommand(approved ? "approval.grant" : "approval.deny", {
      requestId,
      originalAction: pending.action,
    });
  }

  private handleAbort(): void {
    if (!this.session || isTerminal(this.session.status)) return;

    this.sendRunnerCommand("session.shutdown", {});
    if (canTransition(this.session.status, "aborted")) {
      this.transition("aborted", "User aborted session");
    }
  }

  private handleCreatePR(): void {
    if (!this.session || this.session.status !== "review_ready") return;

    this.transition("creating_pr");
    // A2: pass the task description so the runner can ask the agent to
    // author the PR title + body. Runner falls back to "Hermes: <task>"
    // + the hardcoded body on parse failure.
    this.sendRunnerCommand("pr.create", {
      branch: this.session.branch,
      taskDescription: this.session.taskDescription,
    });
  }

  // ---- Runner message handling ----

  private handleRunnerMessage(_ws: WebSocket, data: string | ArrayBuffer): void {
    let msg: RunnerMessage;
    try {
      msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }

    switch (msg.type) {
      case "runner.heartbeat":
        if (this.session) this.session.lastHeartbeat = Date.now();
        break;
      case "runner.event":
        if (msg.payload) {
          const eventType = msg.payload.eventType as HermesEventType;
          const eventPayload = (msg.payload.eventPayload as Record<string, unknown>) ?? {};
          // pr.created / pr.updated both carry the real GitHub URL — route
          // to the PR-completion handler so transitions + PR-index register
          // happen once. pr.updated is emitted by the runner in amend mode
          // (existing PR, push only).
          if (eventType === "pr.created" || eventType === "pr.updated") {
            this.onPRCreated(
              (eventPayload.url as string) ?? "",
              (eventPayload.ownerLogin as string) ?? "",
              eventType,
            );
          } else {
            this.appendEvent(eventType, "opencode", eventPayload);
          }
        }
        break;
      case "runner.command_ack":
        break;
      case "runner.command_error":
        break;
      case "runner.complete":
        this.handleRunnerComplete(msg.payload);
        break;
      case "runner.error":
        if (this.session) {
          this.transition("failed", (msg.payload?.error as string) ?? "Runner error");
        }
        break;
    }
  }

  private handleRunnerComplete(payload?: Record<string, unknown>): void {
    if (!this.session) return;

    // PR creation case: payload has prUrl. Route to onPRCreated; this is
    // idempotent if pr.created already advanced us to completed.
    if (payload?.prUrl) {
      // runner.complete carries the PR URL after either flow (create or
      // amend); the discrete pr.created/pr.updated event has already been
      // emitted on the WS, so we don't re-emit it here — onPRCreated
      // dedups on artifacts.prUrl.
      this.onPRCreated(
        payload.prUrl as string,
        (payload.ownerLogin as string) ?? "",
      );
      return;
    }

    // If we're already terminal, the runner is just confirming after the fact.
    if (isTerminal(this.session.status)) return;

    this.artifacts = {
      sessionId: this.session.id,
      summary: payload?.summary as string | undefined,
      diff: payload?.diff as string | undefined,
      changedFiles: (payload?.changedFiles as string[]) ?? [],
      testResult: payload?.testResult as SessionArtifacts["testResult"],
    };

    // Note: runner already emitted git.diff.ready via WS (sandbox-runner.ts).
    // Don't re-emit here — that doubled the diff payload in the event log.
    this.transition("review_ready");
  }

  // ---- Runner commands ----

  private sendRunnerCommand(type: RunnerCommand["type"], payload: Record<string, unknown>): void {
    const ws = this.getRunnerWS();
    if (!ws) return;

    const command: RunnerCommand = {
      commandId: generateCommandId(),
      type,
      payload,
      createdAt: Date.now(),
    };

    try {
      ws.send(JSON.stringify({ type: "command", command }));
    } catch {
      // Runner socket dead; webSocketClose will clean up state.
    }
  }

  private sendInitialPrompt(): void {
    if (!this.session || !this.profile) return;

    const contextPackage = this.renderContextPackage();

    this.transition("running");
    this.appendEvent("agent.started", "system", { taskDescription: this.session.taskDescription });

    this.sendRunnerCommand("agent.prompt", {
      taskDescription: this.session.taskDescription,
      context: contextPackage,
      model: this.profile.model,
      allowedTools: this.profile.allowedTools,
    });
  }

  private renderContextPackage(): string {
    if (!this.session || !this.profile) return "";

    // A3: baseline rules block. Sourced from
    // docs/RESEARCH-AGENT-PROMPTS.md §3 (P1+P3). Synthesises Cline's YOLO
    // prompt + Aider's overeager_prompt + Codex's completion-audit clause
    // — patterns established for unattended coding agents that produce
    // PRs another human reviews.
    //
    // Intentionally short: rules the runner CANNOT enforce itself (e.g.
    // scope discipline, completion audit). Git/push rules are deliberately
    // omitted — those are enforced structurally by the runner (single
    // push code path, single PR creation code path; PR #B will lock down
    // sandbox-side push entirely).
    const lines: string[] = [
      `# Hermes Task Context`,
      ``,
      `## Project: ${this.profile.name}`,
      `## Repository: ${this.profile.repoUrl}`,
      `## Branch: ${this.session.branch}`,
      ``,
      `## Task`,
      `${this.session.taskDescription}`,
      ``,
      `## Working Rules`,
      ``,
      `You are running unattended inside an ephemeral sandbox. No human will`,
      `answer questions or grant permissions mid-run. The control plane`,
      `opens a pull request from your final diff for human review.`,
      `Optimise for a PR that is easy to review.`,
      ``,
      `- Stay in scope. Touch only what the task requires. Do not refactor,`,
      `  reformat, or "improve" adjacent code, comments, imports, or`,
      `  formatting. Every changed line should trace to the task.`,
      `- Match the existing style. Before editing a file, read enough of it`,
      `  (and its neighbours / imports) to copy its conventions — naming,`,
      `  typing, error handling, test layout. Do not introduce a new`,
      `  library, framework, or pattern unless the task explicitly asks.`,
      `- Verify libraries exist. Before using a package, confirm it is`,
      `  already in package.json / pyproject.toml / go.mod / Cargo.toml.`,
      `  Do not invent imports.`,
      `- Do not add speculative comments. Only add comments where the logic`,
      `  is not self-evident. Never leave TODOs in committed code unless`,
      `  the task asks for them.`,
      `- Verify your work. After editing, run the project's test / lint /`,
      `  build commands when they exist. If tests fail, fix the cause; do`,
      `  not weaken or skip the test unless the task explicitly says so.`,
      `- Never commit secrets. Refuse to write .env, credentials, tokens,`,
      `  or private keys into the repo even if asked.`,
      `- Stop cleanly. When the task is complete, end the turn. Do not open`,
      `  a new PR or push (the control plane handles that).`,
      ``,
      `## Before You Finish`,
      ``,
      `Before you stop, re-read the task description and verify, against`,
      `the current state of the worktree, that every requirement has been`,
      `implemented. Treat completion as unproven until you have inspected`,
      `the relevant files or run the relevant commands. Do not redefine`,
      `success around what is easy to ship; if you cannot finish a`,
      `requirement, say so explicitly in your final message so the reviewer`,
      `is not surprised.`,
      ``,
    ];

    if (this.profile.agentsContext) {
      lines.push(`## Project Instructions`, this.profile.agentsContext, ``);
    }

    if (this.session.repoInstructions) {
      // A4: repo-level AGENTS.md / CLAUDE.md / CONVENTIONS.md content,
      // loaded at provision time, capped at REPO_INSTRUCTIONS_MAX_BYTES.
      // Loaded BELOW Working Rules and Project Instructions on purpose
      // so a hostile / outdated repo file cannot override the baseline
      // safety rules (Codex precedence convention; see
      // docs/RESEARCH-AGENT-PROMPTS.md §1.3).
      lines.push(
        `## Repo Instructions (from ${this.session.repoInstructionsSource ?? "repo"})`,
        this.session.repoInstructions,
        ``,
      );
    }

    return lines.join("\n");
  }

  // ---- Approval requests ----

  requestApproval(action: string, details: Record<string, unknown>): string {
    const requestId = generateRequestId();
    const commandId = generateCommandId();

    this.pendingApprovals.set(requestId, { action, commandId });

    if (this.session?.status === "running") {
      this.transition("needs_approval");
    }

    this.appendEvent("approval.requested", "runner", { requestId, action, ...details });

    return requestId;
  }

  // ---- Heartbeat ----

  // Uses ctx.storage.setAlarm() instead of setInterval so the watchdog
  // survives DO eviction/hibernation (skill: durable-objects/gotchas
  // "setTimeout Didn't Fire After Restart"). The alarm() handler reschedules
  // itself for as long as the session is active and connected.
  private startHeartbeatCheck(): void {
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS));
  }

  private stopHeartbeatCheck(): void {
    this.ctx.waitUntil(this.ctx.storage.deleteAlarm());
  }

  // Single alarm handler — currently only used for the heartbeat watchdog.
  // If you add more scheduled work, use a queue pattern (one alarm, many
  // tasks) per skill: durable-objects/gotchas "Only One Alarm Allowed".
  override async alarm(): Promise<void> {
    if (!this.session) {
      await this.restore();
      if (!this.session) return;
    }
    this.checkHeartbeat();
    // Reschedule unless the watchdog decided to stop (terminal state, or
    // checkHeartbeat already transitioned to failed and called stop).
    if (
      this.session &&
      !isTerminal(this.session.status) &&
      this.session.status !== "creating_pr" &&
      this.session.status !== "review_ready"
    ) {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
    }
  }

  private checkHeartbeat(): void {
    if (!this.session) return;
    if (isTerminal(this.session.status)) {
      this.stopHeartbeatCheck();
      return;
    }
    // Once a PR is being created the runner intentionally goes quiet (it
    // exits after pushing). Don't flag that as a stall.
    if (this.session.status === "creating_pr") return;
    // At review_ready the runner has finished its turn and is idle waiting
    // for the next prompt. E2B may pause the sandbox after 15 min idle (M2
    // auto-pause), which silences heartbeats — but the session is fine and
    // a follow-up prompt should still work. Don't flag this as failed; the
    // launcher's hard deadline (24h) is the absolute cap.
    if (this.session.status === "review_ready") return;

    const now = Date.now();
    const lastBeat = this.session.lastHeartbeat ?? 0;
    // M5: runner disconnected (sandbox likely paused) is no longer the
    // same as "runner crashed". POST /prompt will trigger /resume; until
    // then, stay quiet rather than transition to failed.
    if (!this.session.runnerConnected || lastBeat === 0) return;

    if (now - lastBeat > HEARTBEAT_TIMEOUT_MS) {
      this.appendEvent("system.stalled", "system", { lastHeartbeat: lastBeat });
      if (canTransition(this.session.status, "stalled")) {
        this.transition("stalled", "Heartbeat timeout");
        if (canTransition("stalled", "failed")) {
          this.transition("failed", "Runner stalled");
        }
      }
      this.stopHeartbeatCheck();
    }
  }

  // ---- PR created callback ----

  onPRCreated(
    prUrl: string,
    ownerLogin: string = "",
    eventKind: "pr.created" | "pr.updated" = "pr.created",
  ): void {
    if (!this.artifacts) {
      this.artifacts = { sessionId: this.session?.id ?? "", changedFiles: [] };
    }
    const alreadyRegistered = this.artifacts.prUrl === prUrl;
    if (alreadyRegistered && this.session && isTerminal(this.session.status)) {
      // Already processed; idempotent no-op.
      return;
    }
    this.artifacts.prUrl = prUrl;

    this.appendEvent(eventKind, "runner", { url: prUrl, ownerLogin });

    // Register the PR in the global index so webhook deliveries and
    // follow-up MCP calls can map this PR back to our session id.
    // Fire-and-forget — the worker rolls the storage write into the
    // current request lifetime; a failure to register only loses the
    // lifecycle update path, not the PR itself.
    if (!alreadyRegistered && this.session) {
      const sessionId = this.session.id;
      this.ctx.waitUntil((async () => {
        try {
          const prKey = prKeyFromUrl(prUrl);
          const stub = getPrIndexStub(this.env);
          await (stub as unknown as {
            register(k: string, s: string, o: string): Promise<unknown>;
          }).register(prKey, sessionId, ownerLogin);
        } catch (err) {
          console.error(`[DO] PR_INDEX_DO.register failed: ${(err as Error).message}`);
        }
      })());
    }

    if (this.session?.status === "creating_pr" && canTransition("creating_pr", "completed")) {
      this.transition("completed");
      this.appendEvent("session.completed", "system", { prUrl });
    }

    this.stopHeartbeatCheck();
  }

  // ---- Persistence ----

  private async persist(): Promise<void> {
    if (!this.session) return;
    await this.ctx.storage.put("session", this.session);
    if (this.profile) await this.ctx.storage.put("profile", this.profile);
    if (this.runnerToken) await this.ctx.storage.put("runnerToken", this.runnerToken);
    if (this.artifacts) await this.ctx.storage.put("artifacts", this.artifacts);
  }

  async restore(): Promise<void> {
    const session = await this.ctx.storage.get<Session>("session");
    const profile = await this.ctx.storage.get<ProjectProfile>("profile");
    const token = await this.ctx.storage.get<string>("runnerToken");
    const artifacts = await this.ctx.storage.get<SessionArtifacts>("artifacts");

    if (session) this.session = session;
    if (profile) this.profile = profile;
    if (token) this.runnerToken = token;
    if (artifacts) this.artifacts = artifacts;

    // Restore the event log from per-key entries. list() returns keys in
    // lexicographic order — eventKey() zero-pads to keep that == seq order.
    const stored = await this.ctx.storage.list<HermesEvent>({ prefix: "evt:" });
    if (stored.size > 0) {
      this.eventLog.clear();
      for (const event of stored.values()) {
        this.eventLog.appendExisting(event);
      }
    }
  }

  // ---- RPC methods (called via stub.<method>() from the Worker) ----

  // initSession is the RPC-facing wrapper around init(). It also returns the
  // runnerToken in the response payload — keeping the previous /init shape.
  async initSession(
    profile: ProjectProfile,
    taskDescription: string,
    controlBaseUrl: string,
    amendPrUrl?: string,
    branchSuffix?: string,
  ): Promise<Session & { runnerToken: string | null }> {
    await this.ensureRestored();
    const session = await this.init(profile, taskDescription, controlBaseUrl, amendPrUrl, branchSuffix);
    return { ...session, runnerToken: this.runnerToken };
  }

  async getState(): Promise<{
    session: Session | null;
    events: HermesEvent[];
    artifacts: SessionArtifacts | null;
    repoUrl: string | null;
    baseBranch: string | null;
  }> {
    await this.ensureRestored();
    return {
      session: this.session,
      events: this.eventLog.getAll(),
      artifacts: this.artifacts,
      // Surface just the project fields the launcher needs to re-provision
      // for amend mode. Keeping the full profile out for now — it carries
      // model + tool allow-lists that are not part of the public contract.
      repoUrl: this.profile?.repoUrl ?? null,
      baseBranch: this.profile?.defaultBranch ?? null,
    };
  }

  async approveRequest(requestId: string): Promise<{ ok: true }> {
    await this.ensureRestored();
    this.handleApproval(true, { requestId });
    return { ok: true };
  }

  async abortSession(): Promise<{ ok: true }> {
    await this.ensureRestored();
    this.handleAbort();
    return { ok: true };
  }

  async createPR(): Promise<{ ok: true }> {
    await this.ensureRestored();
    this.handleCreatePR();
    return { ok: true };
  }

  // A4 / PR #A: launcher calls this after cloning the repo and reading
  // AGENTS.md / CLAUDE.md / CONVENTIONS.md (capped 8 KB). Must arrive
  // before the runner WS connects so renderContextPackage picks it up
  // on the first turn. If the runner has already connected and the
  // first prompt fired, we still store it for follow-up prompts.
  async setRepoInstructions(input: {
    source: "AGENTS.md" | "CLAUDE.md" | "CONVENTIONS.md";
    content: string;
  }): Promise<{ ok: true }> {
    await this.ensureRestored();
    if (!this.session) return { ok: true };
    this.session.repoInstructions = input.content;
    this.session.repoInstructionsSource = input.source;
    await this.persist();
    this.appendEvent("repo.instructions.loaded", "system", {
      source: input.source,
      bytes: input.content.length,
    });
    return { ok: true };
  }

  // Called by the webhook handler when a verified pull_request event
  // for THIS session's PR arrives. Idempotent — callers must dedup by
  // X-GitHub-Delivery against the PR index BEFORE this runs.
  //
  // Transitions (only the completed branch is reachable today; we keep
  // the guards explicit so failing/aborted sessions still get the event
  // logged without throwing):
  //   completed + pr.merged   -> emit pr.merged, transition to archived
  //   completed + pr.closed   -> emit pr.closed, stay completed
  //   other     + pr.merged   -> emit only (no transition)
  //   other     + pr.closed   -> emit only
  /** Append a pr.autofix.triggered (or pr.autofix.skipped) event to the
   *  parent session's event log so the user sees the cause-and-effect in
   *  one place. Called by the webhook handler after a successful (or
   *  rejected) tryClaimAmendSlot. Idempotent on (deliveryId, trigger):
   *  the index DO dedup ring already covers webhook-level retries. */
  async appendAutofixEvent(input: {
    triggered: boolean;
    trigger: "review_changes_requested" | "check_run_failed";
    deliveryId: string;
    headSha: string;
    newSessionId?: string;          // present when triggered === true
    skipReason?: string;            // present when triggered === false
    reviewerLogin?: string;         // review trigger
    checkName?: string;             // check_run trigger
    detailsUrl?: string;            // check_run trigger
  }): Promise<{ ok: true }> {
    await this.ensureRestored();
    if (!this.session) return { ok: true };
    this.appendEvent(
      input.triggered ? "pr.autofix.triggered" : "pr.autofix.skipped",
      "system",
      {
        trigger: input.trigger,
        deliveryId: input.deliveryId,
        headSha: input.headSha,
        newSessionId: input.newSessionId,
        skipReason: input.skipReason,
        reviewerLogin: input.reviewerLogin,
        checkName: input.checkName,
        detailsUrl: input.detailsUrl,
      },
    );
    return { ok: true };
  }

  async ingestPrLifecycleEvent(input: {
    merged: boolean;
    prUrl: string;
    deliveryId: string;
    senderLogin: string;
  }): Promise<{ ok: true; archived: boolean }> {
    await this.ensureRestored();
    if (!this.session) return { ok: true, archived: false };

    const type = input.merged ? "pr.merged" : "pr.closed";
    this.appendEvent(type, "system", {
      prUrl: input.prUrl,
      deliveryId: input.deliveryId,
      senderLogin: input.senderLogin,
    });

    let archived = false;
    if (
      input.merged &&
      this.session.status === "completed" &&
      canTransition("completed", "archived")
    ) {
      this.transition("archived");
      archived = true;
    }
    return { ok: true, archived };
  }

  async sendPrompt(text: string): Promise<PromptResult> {
    await this.ensureRestored();
    const status = this.session?.status;
    // Session is in a terminal state — sandbox is gone, no recovery.
    if (status && isTerminal(status)) {
      return {
        kind: "terminal",
        status,
        body: {
          error: "Session ended",
          status,
          reason:
            "The session reached a terminal state and its sandbox has been torn down. " +
            "Start a new session to continue the work; the previous diff and PR (if any) " +
            "are preserved in the session record.",
          recoverable: false,
        },
      };
    }
    // M5: detect "sandbox paused" by either explicit WS close OR stale
    // heartbeat. E2B pause freezes the TCP socket without sending a FIN,
    // so a paused sandbox can look like runnerConn != null but heartbeat
    // is stale (verified by the §12.14 probe). Either signal routes us
    // through the queue+resume path.
    const now = Date.now();
    const lastBeat = this.session?.lastHeartbeat ?? 0;
    const heartbeatStale = lastBeat > 0 && (now - lastBeat) > PAUSED_HEARTBEAT_THRESHOLD_MS;
    const runnerWS = this.getRunnerWS();
    if (!runnerWS || heartbeatStale) {
      const launcherUrl = this.env.CONTROL_PLANE_LAUNCHER_URL;
      // Force-close the dead WS so getRunnerWS() reports null on the next call.
      // E2B pause freezes the TCP socket without sending a FIN; without this
      // explicit close, ctx.getWebSockets("runner") would still return it.
      // webSocketClose will fire when the sandbox eventually resumes — by then
      // session.runnerConnected is already false.
      if (runnerWS && heartbeatStale) {
        try { runnerWS.close(4000, "paused"); } catch {}
        if (this.session) this.session.runnerConnected = false;
        this.appendEvent("runner.disconnected", "system", { reason: "heartbeat stale, sandbox likely paused" });
      }
      if (!launcherUrl) {
        // Pre-M5 deployment: no launcher URL configured. Fall back to
        // the §12.13 fail-fast 409.
        return {
          kind: "no_resume",
          status,
          body: {
            error: "Runner not connected",
            status,
            reason:
              "Resume is not configured (CONTROL_PLANE_LAUNCHER_URL unset). Start a new session.",
            recoverable: false,
          },
        };
      }
      if (this.session) {
        this.session.pendingPrompt = text;
        await this.persist();
      }
      this.appendEvent("agent.started", "user", { taskDescription: text, queued: true });
      // Fire-and-forget the resume; runner.connected handler drains the
      // queue. We do NOT await — that would block the caller for the full
      // ~1s Sandbox.connect roundtrip + the runner's reconnect budget.
      const sessionId = this.session?.id;
      if (sessionId) {
        this.ctx.waitUntil(
          (async () => {
            try {
              const r = await fetch(
                `${launcherUrl}/sessions/${sessionId}/resume`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-hermes-launcher-secret": this.env.HERMES_LAUNCHER_SECRET ?? "",
                  },
                },
              );
              if (!r.ok) {
                const body = await r.text().catch(() => "<no body>");
                console.error(`[DO] launcher /resume failed ${r.status}: ${body}`);
              }
            } catch (err) {
              console.error(`[DO] launcher /resume error: ${(err as Error).message}`);
            }
          })(),
        );
      }
      return {
        kind: "queued",
        status,
        body: {
          ok: true,
          queued: true,
          status,
          reason:
            "Sandbox is paused; resume initiated. The follow-up prompt will be delivered as soon as the runner reconnects (usually < 5 s).",
          recoverable: true,
        },
      };
    }
    // If the session is sitting at review_ready (first turn done, no
    // PR yet), transition back to running so the second turn doesn't
    // throw on the runner.complete -> review_ready re-transition.
    if (this.session?.status === "review_ready") {
      this.transition("running");
    }
    this.appendEvent("agent.started", "user", { taskDescription: text });
    this.sendRunnerCommand("agent.prompt", {
      taskDescription: text,
      context: text,
      model: this.profile?.model ?? "",
      allowedTools: this.profile?.allowedTools ?? [],
    });
    return { kind: "ok", body: { ok: true } };
  }

  private async ensureRestored(): Promise<void> {
    if (!this.session) await this.restore();
  }

  // ---- HTTP fetch — WebSocket upgrade only ----
  // All non-WS routes are RPC methods above (skill: workers/gotchas
  // "Durable Object RPC errors with deprecated fetch pattern").

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (!this.session) {
      await this.restore();
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Determine role from path: /sessions/:id/runner = runner, /sessions/:id/stream = client
    const pathParts = url.pathname.split("/");
    const role = pathParts[pathParts.length - 1] === "runner" ? "runner" : "client";
    const token = url.searchParams.get("token") ?? "";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === "runner") {
      await this.handleRunnerWS(server, token);
    } else {
      await this.handleClientWS(server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Hibernation API handlers ----
  // Called by the runtime when an inbound message/close arrives on a
  // hibernated WS (skill: workers/gotchas "WebSocket connection closes
  // unexpectedly"). this.session may be null until restore() runs.

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (!this.session) await this.restore();
    const att = this.readAttachment(ws);
    if (att.tag === WS_TAGS.RUNNER) {
      this.handleRunnerMessage(ws, data);
    } else {
      this.handleClientMessage(ws, data);
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    if (!this.session) await this.restore();
    const att = this.readAttachment(ws);
    if (att.tag === WS_TAGS.RUNNER && this.session) {
      this.session.runnerConnected = false;
      this.appendEvent("runner.disconnected", "runner");
      this.stopHeartbeatCheck();
    }
    // Client closes are noise — no event to emit.
  }

  override async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Errors are always followed by webSocketClose; nothing to do here.
  }
}

// Result envelope for sendPrompt — discriminated union so the Worker can
// map RPC results back onto HTTP status codes without re-parsing strings.
export type PromptResult =
  | { kind: "terminal"; status: SessionStatus | undefined; body: Record<string, unknown> }
  | { kind: "no_resume"; status: SessionStatus | undefined; body: Record<string, unknown> }
  | { kind: "queued"; status: SessionStatus | undefined; body: Record<string, unknown> }
  | { kind: "ok"; body: { ok: true } };
