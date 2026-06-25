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
import { canTransition, isTerminal } from "../core/state-machine";
import { generateCommandId, generateRunnerToken, generateRequestId } from "../core/id";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, PAUSED_HEARTBEAT_THRESHOLD_MS, WS_TAGS } from "../core/constants";

interface WSConnection {
  ws: WebSocket;
  tag: typeof WS_TAGS.CLIENT | typeof WS_TAGS.RUNNER;
  lastSeq: number;
}

export class SessionDurableObject extends DurableObject<CloudflareEnv> {
  private session: Session | null = null;
  private profile: ProjectProfile | null = null;
  private eventLog = new EventLog();
  private connections = new Set<WSConnection>();
  private runnerConn: WSConnection | null = null;
  private runnerToken: string | null = null;
  private pendingApprovals = new Map<string, { action: string; commandId: string }>();
  private artifacts: SessionArtifacts | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private controlBaseUrl: string | null = null;

  // ---- Lifecycle ----

  async init(
    profile: ProjectProfile,
    taskDescription: string,
    controlBaseUrl: string,
  ): Promise<Session> {
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
      branch: `hermes/${sessionId.slice(-8)}`,
      createdAt: now,
      updatedAt: now,
      runnerConnected: false,
    };
    this.profile = profile;
    this.runnerToken = generateRunnerToken();
    this.controlBaseUrl = controlBaseUrl;

    this.appendEvent("session.created", "system", { taskDescription, projectId: profile.id });
    await this.persist();

    // Kick off sandbox provisioning in the background. The HTTP response
    // returns immediately; status will advance via events as the sandbox
    // boots and the runner connects back over WebSocket.
    this.ctx.waitUntil(this.provisionSandbox());

    return this.session;
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
      template: this.env.E2B_TEMPLATE ?? "hermes-runner",
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

    // Auto-teardown sandbox on any terminal state.
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
    return event;
  }

  private broadcastEvent(event: HermesEvent): void {
    const msg = JSON.stringify({ type: "event", event });
    for (const conn of this.connections) {
      if (conn.lastSeq < event.seq) {
        try {
          conn.ws.send(msg);
          conn.lastSeq = event.seq;
        } catch {
          this.connections.delete(conn);
        }
      }
    }
  }

  // ---- WebSocket: Client ----

  async handleClientWS(ws: WebSocket): Promise<void> {
    ws.accept();
    const conn: WSConnection = { ws, tag: WS_TAGS.CLIENT, lastSeq: -1 };
    this.connections.add(conn);

    // Replay events to new client
    const replay = this.eventLog.getAll();
    if (replay.length > 0) {
      ws.send(JSON.stringify({ type: "replay", events: replay }));
      conn.lastSeq = this.eventLog.getLatestSeq();
    }

    ws.send(JSON.stringify({ type: "session_state", session: this.session }));

    ws.addEventListener("message", (e) => this.handleClientMessage(conn, e));
    ws.addEventListener("close", () => this.connections.delete(conn));
    ws.addEventListener("error", () => this.connections.delete(conn));
  }

  // ---- WebSocket: Runner ----

  async handleRunnerWS(ws: WebSocket, token: string): Promise<void> {
    ws.accept();

    if (token !== this.runnerToken) {
      ws.close(4001, "Invalid runner token");
      return;
    }
    if (!this.session) {
      ws.close(4002, "Session not found");
      return;
    }

    const conn: WSConnection = { ws, tag: WS_TAGS.RUNNER, lastSeq: -1 };
    this.connections.add(conn);
    this.runnerConn = conn;

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
      // If we're sitting at review_ready, transition back to running so
      // the second runner.complete doesn't re-fail the state machine.
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

    ws.addEventListener("message", (e) => this.handleRunnerMessage(conn, e));
    ws.addEventListener("close", () => {
      this.connections.delete(conn);
      if (this.runnerConn === conn) {
        this.runnerConn = null;
        this.appendEvent("runner.disconnected", "runner");
        this.stopHeartbeatCheck();
      }
    });
    ws.addEventListener("error", () => this.connections.delete(conn));
  }

  // ---- Client message handling ----

  private handleClientMessage(conn: WSConnection, e: MessageEvent): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(e.data as string);
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
    this.sendRunnerCommand("pr.create", { branch: this.session.branch });
  }

  // ---- Runner message handling ----

  private handleRunnerMessage(conn: WSConnection, e: MessageEvent): void {
    let msg: RunnerMessage;
    try {
      msg = JSON.parse(e.data as string);
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
          // pr.created carries the real GitHub URL — route to the PR-completion
          // handler instead of appending a duplicate untracked event.
          if (eventType === "pr.created") {
            this.onPRCreated((eventPayload.url as string) ?? "");
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
      this.onPRCreated(payload.prUrl as string);
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
    if (!this.runnerConn) return;

    const command: RunnerCommand = {
      commandId: generateCommandId(),
      type,
      payload,
      createdAt: Date.now(),
    };

    this.runnerConn.ws.send(JSON.stringify({ type: "command", command }));
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
    ];

    if (this.profile.agentsContext) {
      lines.push(`## Project Instructions`, this.profile.agentsContext, ``);
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

  private startHeartbeatCheck(): void {
    this.stopHeartbeatCheck();
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeatCheck(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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

  onPRCreated(prUrl: string): void {
    if (!this.artifacts) {
      this.artifacts = { sessionId: this.session?.id ?? "", changedFiles: [] };
    }
    if (this.artifacts.prUrl === prUrl && this.session && isTerminal(this.session.status)) {
      // Already processed; idempotent no-op.
      return;
    }
    this.artifacts.prUrl = prUrl;

    this.appendEvent("pr.created", "runner", { url: prUrl });

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
    await this.ctx.storage.put("events", this.eventLog.getAll());
    if (this.runnerToken) await this.ctx.storage.put("runnerToken", this.runnerToken);
  }

  async restore(): Promise<void> {
    const session = await this.ctx.storage.get<Session>("session");
    const profile = await this.ctx.storage.get<ProjectProfile>("profile");
    const token = await this.ctx.storage.get<string>("runnerToken");

    if (session) this.session = session;
    if (profile) this.profile = profile;
    if (token) this.runnerToken = token;
  }

  // ---- HTTP fetch (routes from Worker) ----

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Restore from storage if needed
    if (!this.session) {
      await this.restore();
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    // ---- Internal routes (from Worker API) ----

    if (path === "/init" && request.method === "POST") {
      const { profile, taskDescription, controlBaseUrl } = await request.json<{
        profile: ProjectProfile;
        taskDescription: string;
        controlBaseUrl: string;
      }>();
      const session = await this.init(profile, taskDescription, controlBaseUrl);
      return new Response(JSON.stringify({
        ...session,
        runnerToken: this.getRunnerToken(),
      }), { headers: corsHeaders });
    }

    if (path === "/state" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          session: this.session,
          events: this.eventLog.getAll(),
          artifacts: this.artifacts,
        }),
        { headers: corsHeaders },
      );
    }

    if (path === "/approve" && request.method === "POST") {
      const body = await request.json<{ requestId: string }>();
      this.handleApproval(true, { requestId: body.requestId });
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    if (path === "/abort" && request.method === "POST") {
      this.handleAbort();
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    if (path === "/create-pr" && request.method === "POST") {
      this.handleCreatePR();
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    if (path === "/prompt" && request.method === "POST") {
      const status = this.session?.status;
      // Session is in a terminal state — sandbox is gone, no recovery.
      if (status && isTerminal(status)) {
        return new Response(
          JSON.stringify({
            error: "Session ended",
            status,
            reason:
              "The session reached a terminal state and its sandbox has been torn down. " +
              "Start a new session to continue the work; the previous diff and PR (if any) " +
              "are preserved in the session record.",
            recoverable: false,
          }),
          { status: 410, headers: corsHeaders },
        );
      }
      // M5: detect "sandbox paused" by either explicit WS close OR stale
      // heartbeat. E2B pause freezes the TCP socket without sending a FIN,
      // so a paused sandbox can look like runnerConn != null but heartbeat
      // is stale (verified by the §12.14 probe). Either signal routes us
      // through the queue+resume path.
      const now = Date.now();
      const lastBeat = this.session?.lastHeartbeat ?? 0;
      const heartbeatStale = lastBeat > 0 && (now - lastBeat) > PAUSED_HEARTBEAT_THRESHOLD_MS;
      if (!this.runnerConn || heartbeatStale) {
        const launcherUrl = this.env.CONTROL_PLANE_LAUNCHER_URL;
        // Clear the dead WS reference so subsequent runner-state checks
        // (heartbeat watchdog, future sends) don't see a phantom alive
        // runner. The actual close event will fire later once the sandbox
        // resumes (M5 §12.14 probe finding), at which point handleClose
        // is a no-op because runnerConn is already null.
        if (this.runnerConn && heartbeatStale) {
          try { this.runnerConn.ws.close(4000, "paused"); } catch {}
          this.connections.delete(this.runnerConn);
          this.runnerConn = null;
          if (this.session) this.session.runnerConnected = false;
          this.appendEvent("runner.disconnected", "system", { reason: "heartbeat stale, sandbox likely paused" });
        }
        if (!launcherUrl) {
          // Pre-M5 deployment: no launcher URL configured. Fall back to
          // the §12.13 fail-fast 409.
          return new Response(
            JSON.stringify({
              error: "Runner not connected",
              status,
              reason:
                "Resume is not configured (CONTROL_PLANE_LAUNCHER_URL unset). Start a new session.",
              recoverable: false,
            }),
            { status: 409, headers: corsHeaders },
          );
        }
        const { text } = await request.json<{ text: string }>();
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
                  { method: "POST", headers: { "content-type": "application/json" } },
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
        return new Response(
          JSON.stringify({
            ok: true,
            queued: true,
            status,
            reason:
              "Sandbox is paused; resume initiated. The follow-up prompt will be delivered as soon as the runner reconnects (usually < 5 s).",
            recoverable: true,
          }),
          { status: 202, headers: corsHeaders },
        );
      }
      const { text } = await request.json<{ text: string }>();
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
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    // ---- WebSocket upgrade ----
    const upgradeHeader = request.headers.get("Upgrade");
    console.log(`[DO fetch] path=${url.pathname} upgrade=${upgradeHeader} role=${url.searchParams.get("role")}`);
    if (upgradeHeader === "websocket") {
      // Determine role from path: /sessions/:id/runner = runner, /sessions/:id/stream = client
      const pathParts = url.pathname.split("/");
      const wsRole = pathParts[pathParts.length - 1] === "runner" ? "runner" : "client";
      const role = wsRole;
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

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: corsHeaders,
    });
  }
}
