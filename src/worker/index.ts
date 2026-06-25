// ============================================================
// Hermes Control Plane - Worker API
// Routes: create session, get session, WS stream, approve/deny, abort, create PR
// ============================================================

import { SessionDurableObject } from "./session-do";
import { PrIndexDurableObject } from "./pr-index-do";
import type { PromptResult } from "./session-do";
import type {
  ProjectProfile,
  Session,
  HermesEvent,
  SessionArtifacts,
} from "../core/types";

// RPC contract surface — explicit interface so TS does not have to walk the
// full DO class (whose return shapes contain Record<string, unknown> which
// fails CF's Rpc.Serializable<T> check). The DO class implements the same
// signatures.
interface SessionDORpc {
  initSession(
    profile: ProjectProfile,
    taskDescription: string,
    controlBaseUrl: string,
  ): Promise<Session & { runnerToken: string | null }>;
  getState(): Promise<{
    session: Session | null;
    events: HermesEvent[];
    artifacts: SessionArtifacts | null;
  }>;
  approveRequest(requestId: string): Promise<{ ok: true }>;
  abortSession(): Promise<{ ok: true }>;
  createPR(): Promise<{ ok: true }>;
  sendPrompt(text: string): Promise<PromptResult>;
}

// Cast helper: the DO stub really does implement these methods at runtime,
// but workers-types' Rpc.Provider<T> resolves to `never` here because our
// payloads use `Record<string, unknown>`. Use a single cast so the rest of
// this file stays type-safe.
function asRpc(stub: unknown): SessionDORpc {
  return stub as SessionDORpc;
}

export { SessionDurableObject, PrIndexDurableObject };

// ---- In-memory project profiles (MVP: replace with D1 later) ----

const DEFAULT_PROFILE: ProjectProfile = {
  id: "default",
  name: "Default Project",
  repoUrl: "",
  defaultBranch: "main",
  model: "zai-coding-plan/glm-5.2",
  allowedTools: ["read", "edit", "bash", "grep", "glob"],
  approvalPolicy: {
    autoAllow: ["file.read", "file.edit", "test.run"],
    requireApproval: ["git.push", "pr.create", "shell.destructive"],
  },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

const PROMPT_STATUS_BY_KIND: Record<string, number> = {
  terminal: 410,
  no_resume: 409,
  queued: 202,
  ok: 200,
};

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- CORS ----
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    try {
      // Debug: log all requests
      console.log(`[debug] ${request.method} ${path} Upgrade=${request.headers.get("Upgrade")}`);

      // ---- Health ----
      if (path === "/health" || path === "/") {
        return new Response(
          JSON.stringify({ status: "ok", service: "hermes-control-plane" }),
          { headers: CORS_HEADERS },
        );
      }

      // ---- Create session ----
      // POST /sessions
      // Body: { projectId, taskDescription, repoUrl?, profile? }
      if (path === "/sessions" && request.method === "POST") {
        const body = await request.json<{
          projectId: string;
          taskDescription: string;
          repoUrl?: string;
          profile?: Partial<ProjectProfile>;
        }>();

        // Build profile. LLM credentials (ZAI_API_KEY etc.) and any other
        // per-session env vars are injected host-side by the launcher into
        // the sandbox's start.json (src/launcher/provision.ts) — the Worker
        // does not need them.
        const profile: ProjectProfile = {
          ...DEFAULT_PROFILE,
          ...body.profile,
          id: body.projectId,
          repoUrl: body.repoUrl ?? DEFAULT_PROFILE.repoUrl,
          env: {
            ...(body.profile?.env ?? {}),
          },
        };

        // Create DO stub
        const id = env.SESSION_DO.newUniqueId();
        const stub = env.SESSION_DO.get(id);

        // The DO/sandbox runner needs a publicly reachable URL to dial back
        // for the WS bridge. Prefer the explicit PUBLIC_BASE_URL secret (set
        // to e.g. an ngrok URL locally, or the deployed Worker URL in prod);
        // fall back to the request origin which is correct in production
        // when the client hits the deployed Worker directly.
        const controlBaseUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? url.origin;

        const session = await asRpc(stub).initSession(profile, body.taskDescription, controlBaseUrl);

        return new Response(JSON.stringify(session), {
          status: 201,
          headers: CORS_HEADERS,
        });
      }

      // ---- WebSocket: any /sessions/:id/ws upgrade ----
      // Client: GET /sessions/:id/stream (role=client)
      // Runner: GET /sessions/:id/runner?token=xxx (role=runner)
      const isWSUpgrade = request.headers.get("Upgrade") === "websocket";
      const wsMatch = path.match(/^\/sessions\/([^/]+)\/(stream|runner)$/);

      if (isWSUpgrade && wsMatch) {
        const sessionId = wsMatch[1];
        const wsType = wsMatch[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);

        console.log(`[worker] WS upgrade: type=${wsType} sessionId=${sessionId.slice(0,8)}... calling stub.fetch`);
        const wsResp = await stub.fetch(request);
        console.log(`[worker] WS response status: ${wsResp.status} webSocket: ${!!wsResp.webSocket}`);
        return wsResp;
      }

      // ---- Get session state ----
      // GET /sessions/:id
      if (path.startsWith("/sessions/") && request.method === "GET") {
        const sessionId = path.split("/")[2];
        let id: DurableObjectId;
        try {
          id = env.SESSION_DO.idFromString(sessionId);
        } catch {
          return new Response(
            JSON.stringify({ error: "session not found" }),
            { status: 404, headers: CORS_HEADERS },
          );
        }
        const stub = env.SESSION_DO.get(id);

        const data = await asRpc(stub).getState();
        // DO auto-instantiates empty; treat a missing session as 404.
        if (!data.session) {
          return new Response(
            JSON.stringify({ error: "session not found" }),
            { status: 404, headers: CORS_HEADERS },
          );
        }

        return new Response(JSON.stringify(data), { headers: CORS_HEADERS });
      }

      // ---- Approve action ----
      // POST /sessions/:id/approve  body: { requestId }
      if (path.endsWith("/approve") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);
        const body = await request.json<{ requestId: string }>();
        const result = await asRpc(stub).approveRequest(body.requestId);
        return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
      }

      // ---- Abort session ----
      // POST /sessions/:id/abort
      if (path.endsWith("/abort") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);
        const result = await asRpc(stub).abortSession();
        return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
      }

      // ---- Follow-up prompt (M2) ----
      // POST /sessions/:id/prompt   body: { text }
      if (path.endsWith("/prompt") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);
        const { text } = await request.json<{ text: string }>();
        const result = await asRpc(stub).sendPrompt(text);
        const status = PROMPT_STATUS_BY_KIND[result.kind] ?? 200;
        return new Response(JSON.stringify(result.body), {
          status,
          headers: CORS_HEADERS,
        });
      }

      // ---- Create PR ----
      // POST /sessions/:id/create-pr
      if (path.endsWith("/create-pr") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);
        const result = await asRpc(stub).createPR();
        return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: CORS_HEADERS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return new Response(
        JSON.stringify({ error: message }),
        { status: 500, headers: CORS_HEADERS },
      );
    }
  },
};
