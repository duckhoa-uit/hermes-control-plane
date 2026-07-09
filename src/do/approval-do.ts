// ============================================================
// ApprovalDurableObject — Hermes-compatible approval queue
// ============================================================
// SQLite-backed approval queue with Hibernatable WebSockets for
// long-wait notification. Tools open a WS to the DO and the DO
// hibernates between events; user clicks Approve → DO wakes,
// sends message to the tool's WS → tool resumes.

import { DurableObject } from "cloudflare:workers";

interface ApprovalRow {
  id: string;
  session_id: string;
  type: string;
  title: string;
  pattern: string | null;
  payload_json: string;
  status: "pending" | "approved" | "denied" | "timeout";
  decision: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
  expires_at: number;
}

interface FinalizeCheckpointRow {
  session_id: string;
  branch: string;
  phase: string;
  chunk_count: number;
  updated_at: number;
}

const CHECKPOINT_CHUNK_SIZE = 256_000;

export class ApprovalDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initSchema();
    // Set hibernation event timeout to 75 minutes (longer than tool's 1h wait)
    this.ctx.setWebSocketAutoResponse(undefined);
  }

  private initSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'command',
        title TEXT NOT NULL DEFAULT '',
        pattern TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        decision TEXT,
        decided_by TEXT,
        decided_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id);`,
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);`,
    );
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS finalize_checkpoints (
        session_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        phase TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, branch)
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS finalize_checkpoint_chunks (
        session_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, branch, chunk_index)
      );
    `);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // WebSocket upgrade for hibernatable wait
      if (req.headers.get("Upgrade")?.toLowerCase() === "websocket" && path === "/ws-wait") {
        return this.handleWsWait(url, req);
      }
      if (req.method === "POST" && path === "/request") return this.handleRequest(req);
      if (req.method === "GET" && path === "/get") return this.handleGet(url);
      if (req.method === "POST" && path === "/resolve") return this.handleResolve(req);
      if (req.method === "GET" && path === "/list-open") return this.handleListOpen(url);
      if (req.method === "GET" && path === "/finalize-checkpoint") {
        return this.handleGetFinalizeCheckpoint(url);
      }
      if (req.method === "POST" && path === "/finalize-checkpoint") {
        return this.handleSaveFinalizeCheckpoint(req);
      }
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
    return Response.json({ error: "unknown route" }, { status: 404 });
  }

  // ─── /request ────────────────────────────────────────────────────────

  private async handleRequest(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      id: string;
      sessionId: string;
      type: string;
      title: string;
      pattern?: string;
      payload?: unknown;
      timeoutMs?: number;
    };
    const now = Date.now();
    const timeoutMs = body.timeoutMs ?? 3600_000;
    const expiresAt = now + timeoutMs;

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO approvals
       (id, session_id, type, title, pattern, payload_json, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      body.id,
      body.sessionId,
      body.type,
      body.title,
      body.pattern ?? null,
      JSON.stringify(body.payload ?? {}),
      now,
      expiresAt,
    );

    // Schedule auto-timeout alarm
    const current = await this.ctx.storage.getAlarm();
    if (!current || current > expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt + 1000);
    }

    return Response.json({ id: body.id, status: "pending", expires_at: expiresAt });
  }

  // ─── /get?id=... ─────────────────────────────────────────────────────

  private async handleGet(url: URL): Promise<Response> {
    const id = url.searchParams.get("id");
    if (!id) return Response.json({ error: "missing id" }, { status: 400 });
    const row = this.getRow(id);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });

    return Response.json({
      id: row.id,
      session_id: row.session_id,
      type: row.type,
      title: row.title,
      pattern: row.pattern,
      payload: safeParse(row.payload_json),
      status: row.status,
      decision: row.decision,
      decided_by: row.decided_by,
      decided_at: row.decided_at,
      created_at: row.created_at,
      expires_at: row.expires_at,
    });
  }

  // ─── /resolve ────────────────────────────────────────────────────────

  private async handleResolve(req: Request): Promise<Response> {
    const body = (await req.json()) as { id: string; decision: string; actor: string };
    const row = this.getRow(body.id);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    if (row.status !== "pending") {
      return Response.json({ error: `already ${row.status}` }, { status: 409 });
    }

    const status =
      body.decision === "timeout" ? "timeout" : body.decision === "deny" ? "denied" : "approved";

    this.ctx.storage.sql.exec(
      `UPDATE approvals SET status = ?, decision = ?, decided_by = ?, decided_at = ?
       WHERE id = ?`,
      status,
      body.decision,
      body.actor,
      Date.now(),
      body.id,
    );

    // Wake any WebSocket waiters tagged with this approval id
    this.wakeWaiters(body.id, body.decision, body.actor);

    return Response.json({ id: body.id, status: "resolved", decision: body.decision });
  }

  // ─── /list-open ──────────────────────────────────────────────────────

  private async handleListOpen(url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("session_id") ?? "";
    const cursor = sessionId
      ? this.ctx.storage.sql.exec(
          "SELECT * FROM approvals WHERE status = 'pending' AND session_id = ? ORDER BY created_at DESC",
          sessionId,
        )
      : this.ctx.storage.sql.exec(
          "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC",
        );
    const rows = cursor.toArray() as unknown as ApprovalRow[];
    return Response.json({
      approvals: rows.map((r) => ({
        id: r.id,
        session_id: r.session_id,
        type: r.type,
        title: r.title,
        pattern: r.pattern,
        payload: safeParse(r.payload_json),
        status: r.status,
        created_at: r.created_at,
        expires_at: r.expires_at,
      })),
    });
  }

  // ─── Durable finalizer checkpoints ──────────────────────────────────

  private handleGetFinalizeCheckpoint(url: URL): Response {
    const sessionId = url.searchParams.get("session_id") ?? "";
    const branch = url.searchParams.get("branch") ?? "";
    if (!sessionId || !branch) {
      return Response.json({ error: "session_id and branch required" }, { status: 400 });
    }

    const rows = this.ctx.storage.sql
      .exec(
        "SELECT * FROM finalize_checkpoints WHERE session_id = ? AND branch = ?",
        sessionId,
        branch,
      )
      .toArray() as unknown as FinalizeCheckpointRow[];
    const row = rows[0];
    if (!row) return Response.json({ checkpoint: null });

    const chunks = this.ctx.storage.sql
      .exec(
        `SELECT payload FROM finalize_checkpoint_chunks
         WHERE session_id = ? AND branch = ? ORDER BY chunk_index ASC`,
        sessionId,
        branch,
      )
      .toArray() as unknown as { payload: string }[];
    if (chunks.length !== row.chunk_count) {
      return Response.json({ error: "finalize checkpoint is incomplete" }, { status: 500 });
    }

    return Response.json({ checkpoint: safeParse(chunks.map((chunk) => chunk.payload).join("")) });
  }

  private async handleSaveFinalizeCheckpoint(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      sessionId?: string;
      branch?: string;
      checkpoint?: { phase?: string };
    };
    const checkpoint = body.checkpoint;
    if (!body.sessionId || !body.branch || !checkpoint?.phase) {
      return Response.json(
        { error: "sessionId, branch, and checkpoint.phase required" },
        { status: 400 },
      );
    }

    const serialized = JSON.stringify(checkpoint);
    const chunks = chunkString(serialized, CHECKPOINT_CHUNK_SIZE);
    const now = Date.now();

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM finalize_checkpoint_chunks WHERE session_id = ? AND branch = ?",
        body.sessionId,
        body.branch,
      );
      for (let index = 0; index < chunks.length; index++) {
        this.ctx.storage.sql.exec(
          `INSERT INTO finalize_checkpoint_chunks
           (session_id, branch, chunk_index, payload) VALUES (?, ?, ?, ?)`,
          body.sessionId,
          body.branch,
          index,
          chunks[index],
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO finalize_checkpoints
         (session_id, branch, phase, chunk_count, updated_at) VALUES (?, ?, ?, ?, ?)`,
        body.sessionId,
        body.branch,
        checkpoint.phase,
        chunks.length,
        now,
      );
    });

    return Response.json({
      saved: true,
      phase: checkpoint.phase,
      chunks: chunks.length,
      updated_at: now,
    });
  }

  // ─── /ws-wait?id=... ─────────────────────────────────────────────────
  // Hibernatable WebSocket: tool opens this WS and the DO can hibernate.
  // When approval resolved, DO sends the decision and closes the WS.

  private async handleWsWait(url: URL, _req: Request): Promise<Response> {
    const id = url.searchParams.get("id");
    if (!id) return new Response("missing id", { status: 400 });

    const row = this.getRow(id);
    if (!row) return new Response("not found", { status: 404 });

    // Already resolved? Return decision via immediate close
    if (row.status !== "pending") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.send(
        JSON.stringify({
          id,
          decision: row.decision,
          status: row.status,
          decided_by: row.decided_by,
        }),
      );
      server.close(1000, "already resolved");
      return new Response(null, { status: 101, webSocket: client });
    }

    // Create hibernatable WS, tag with approval id
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [`approval:${id}`]);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── Hibernation handlers ────────────────────────────────────────────

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Tool doesn't need to send anything; ignore inbound
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Connection closed (tool aborted, timeout, etc) — nothing to do, tag is gone
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // ignore
  }

  // ─── Alarm: auto-timeout expired approvals ───────────────────────────

  async alarm(): Promise<void> {
    const cursor = this.ctx.storage.sql.exec(
      "SELECT id FROM approvals WHERE status = 'pending' AND expires_at < ?",
      Date.now(),
    );
    const expired = cursor.toArray() as unknown as { id: string }[];
    for (const row of expired) {
      this.autoTimeout(row.id);
    }
    // Reschedule alarm if there are more pending
    const nextCursor = this.ctx.storage.sql.exec(
      "SELECT MIN(expires_at) as next FROM approvals WHERE status = 'pending'",
    );
    const next = (nextCursor.toArray() as unknown as { next: number | null }[])[0];
    if (next?.next) {
      await this.ctx.storage.setAlarm(next.next + 1000);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private getRow(id: string): ApprovalRow | null {
    const cursor = this.ctx.storage.sql.exec("SELECT * FROM approvals WHERE id = ?", id);
    const rows = cursor.toArray() as unknown as ApprovalRow[];
    return rows.length > 0 ? rows[0] : null;
  }

  private autoTimeout(id: string): void {
    const row = this.getRow(id);
    if (!row || row.status !== "pending") return;
    this.ctx.storage.sql.exec(
      `UPDATE approvals SET status = 'timeout', decision = 'timeout', decided_at = ? WHERE id = ?`,
      Date.now(),
      id,
    );
    this.wakeWaiters(id, "timeout", "system");
  }

  /** Send decision to any WS waiters tagged with this approval id. */
  private wakeWaiters(id: string, decision: string, actor: string): void {
    const sockets = this.ctx.getWebSockets(`approval:${id}`);
    const payload = JSON.stringify({ id, decision, actor, status: "resolved" });
    for (const ws of sockets) {
      try {
        ws.send(payload);
        ws.close(1000, "resolved");
      } catch {
        // ignore broken sockets
      }
    }
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function chunkString(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) {
    chunks.push(value.slice(offset, offset + size));
  }
  return chunks.length > 0 ? chunks : [""];
}
