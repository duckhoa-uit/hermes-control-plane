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
  model: "zai-glm-4.6",
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

        // Build profile, inject Zai LLM config from env
        const zaiEnv: Record<string, string> = {};
        if (env.ZAI_API_KEY) zaiEnv.OPENAI_API_KEY = env.ZAI_API_KEY;
        if (env.ZAI_BASE_URL) zaiEnv.OPENAI_BASE_URL = env.ZAI_BASE_URL;
        if (env.ZAI_MODEL) zaiEnv.OPENCODE_MODEL = env.ZAI_MODEL;

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

        // Initialize session
        const initResp = await stub.fetch(
          new Request("https://do.internal/init", {
            method: "POST",
            body: JSON.stringify({ profile, taskDescription: body.taskDescription }),
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

      // ---- Get session state ----
      // GET /sessions/:id
      if (path.startsWith("/sessions/") && request.method === "GET") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);

        const resp = await stub.fetch(new Request("https://do.internal/state"));
        const data = await resp.json();

        return new Response(JSON.stringify(data), { headers: corsHeaders });
      }

      // ---- WebSocket: client stream ----
      // GET /sessions/:id/stream
      if (path.includes("/stream") && request.headers.get("Upgrade") === "websocket") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);

        return stub.fetch(request);
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
