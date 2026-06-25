// ============================================================
// Hermes Control Plane - Worker API
// Routes: create session, get session, WS stream, approve/deny, abort, create PR
// ============================================================

import { SessionDurableObject } from "./session-do";
import type { ProjectProfile } from "../core/types";

export { SessionDurableObject };

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

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    try {
      // Debug: log all requests
      console.log(`[debug] ${request.method} ${path} Upgrade=${request.headers.get("Upgrade")}`);

      // ---- Health ----
      if (path === "/health" || path === "/") {
        return new Response(
          JSON.stringify({ status: "ok", service: "hermes-control-plane" }),
          { headers: corsHeaders },
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

        // M3 concurrency guard is enforced host-side by the launcher
        // (scripts/launch-session.ts) — the Worker runtime hangs/dies when
        // it does an outbound HTTPS fetch to E2B's API from this code path.
        // See docs/ROADMAP.md section 8.6 for the constraint.

        // Build profile, inject Zai LLM config from env.
        // OpenCode supports the `zai-coding-plan` provider natively
        // (via models.dev) - api endpoint is https://api.z.ai/api/coding/paas/v4.
        // We just pass ZHIPU_API_KEY and a "provider/model" model id.
        // No custom opencode.json or baseURL override is needed.
        const zaiEnv: Record<string, string> = {};
        if (env.ZAI_API_KEY) zaiEnv.ZHIPU_API_KEY = env.ZAI_API_KEY;
        if (env.ZAI_MODEL) {
          const m = env.ZAI_MODEL.includes("/") ? env.ZAI_MODEL : `zai-coding-plan/${env.ZAI_MODEL}`;
          zaiEnv.OPENCODE_MODEL = m;
        }

        const profile: ProjectProfile = {
          ...DEFAULT_PROFILE,
          ...body.profile,
          id: body.projectId,
          repoUrl: body.repoUrl ?? DEFAULT_PROFILE.repoUrl,
          env: {
            ...zaiEnv,
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

        // Initialize session
        const initResp = await stub.fetch(
          new Request("https://do.internal/init", {
            method: "POST",
            body: JSON.stringify({
              profile,
              taskDescription: body.taskDescription,
              controlBaseUrl,
            }),
            headers: { "Content-Type": "application/json" },
          }),
        );

        if (!initResp.ok) {
          return new Response(
            JSON.stringify({ error: "Failed to init session" }),
            { status: 500, headers: corsHeaders },
          );
        }

        const session = await initResp.json();

        return new Response(JSON.stringify(session), {
          status: 201,
          headers: corsHeaders,
        });
      }

      // ---- WebSocket: any /sessions/:id/ws upgrade ----
      // Client: GET /sessions/:id/stream (role=client)
      // Runner: GET /sessions/:id/runner?token=xxx (role=runner)
      const isWSUpgrade = request.headers.get("Upgrade") === "websocket";
      const wsMatch = path.match(/^\/sessions\/([^/]+)\/(stream|runner)$/);

      if (isWSUpgrade && wsMatch) {
        const sessionId = wsMatch[1];
        const wsType = wsMatch[2]; // "stream" or "runner"
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
        // Guard against malformed/unknown ids so the orphan sweeper and other
        // callers get a clean 404 instead of an idFromString crash.
        let id;
        try {
          id = env.SESSION_DO.idFromString(sessionId);
        } catch {
          return new Response(
            JSON.stringify({ error: "session not found" }),
            { status: 404, headers: corsHeaders },
          );
        }
        const stub = env.SESSION_DO.get(id);

        const resp = await stub.fetch(new Request("https://do.internal/state"));
        const data = await resp.json();
        // The DO will auto-instantiate empty; treat a missing session.id as 404.
        if (!(data as { session?: unknown }).session) {
          return new Response(
            JSON.stringify({ error: "session not found" }),
            { status: 404, headers: corsHeaders },
          );
        }

        return new Response(JSON.stringify(data), { headers: corsHeaders });
      }

      // ---- Approve action ----
      // POST /sessions/:id/approve  body: { requestId }
      if (path.endsWith("/approve") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);

        return stub.fetch(
          new Request("https://do.internal/approve", {
            method: "POST",
            body: request.body,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      // ---- Abort session ----
      // POST /sessions/:id/abort
      if (path.endsWith("/abort") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);

        return stub.fetch(new Request("https://do.internal/abort", { method: "POST" }));
      }

      // ---- Follow-up prompt (M2) ----
      // POST /sessions/:id/prompt   body: { text }
      if (path.endsWith("/prompt") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);
        return stub.fetch(
          new Request("https://do.internal/prompt", {
            method: "POST",
            body: request.body,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      // ---- Create PR ----
      // POST /sessions/:id/create-pr
      if (path.endsWith("/create-pr") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);

        return stub.fetch(
          new Request("https://do.internal/create-pr", { method: "POST" }),
        );
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return new Response(
        JSON.stringify({ error: message }),
        { status: 500, headers: corsHeaders },
      );
    }
  },
};
