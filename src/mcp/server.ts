// MCP (Model Context Protocol) server bundled into the hermes-launcher.
//
// Exposes hermes-control-plane as a single MCP server with four tools the
// Hermes Agent (and any other MCP host) can call. Mounted on the launcher's
// /mcp endpoint (same port as the launcher's HTTP API), so a single
// Cloudflare Tunnel covers both surfaces.
//
// Hermes Agent integration (Path A — user-side install):
//   ~/.hermes/config.yaml
//     mcp_servers:
//       hermes-control-plane:
//         url: "http://localhost:8789/mcp"      # if Hermes runs on the same VPS
//         # or: "https://launcher.<your-domain>/mcp" if remote
//         timeout: 180
//
// Hermes will discover the four tools below at startup and surface them as
// normal model tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export interface McpServerWiring {
  /** Worker URL (e.g. https://hermes-control-plane.<sub>.workers.dev). */
  workerBaseUrl: string;
  /** Local launcher URL (used for POST /sessions, DELETE /sessions/:id). */
  launcherBaseUrl: string;
  /** Logger — pass the launcher's existing log() to keep one log stream. */
  log: (msg: string) => void;
}

/**
 * Build the MCP server. Returns a `handleRequest(Request): Promise<Response>`
 * that the launcher mounts on `/mcp`. Stateless per-request transport — each
 * MCP call gets a fresh transport, fresh server connection. Simpler than
 * session-keyed mode and matches our existing "one HTTP call = one DO call"
 * pattern.
 */
export function buildMcpHandler(wiring: McpServerWiring): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const server = makeServer(wiring);
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless mode (no session ID). All our tools are single-shot
      // request/response so we ask for a plain JSON body instead of an
      // SSE stream.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(req);
      // No long-lived streams in JSON-response mode, so it's safe to
      // tear the per-request server + transport down immediately.
      await server.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      return res;
    } catch (err) {
      wiring.log(`[mcp] handler error: ${(err as Error).message}`);
      await server.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" } }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  };
}

function makeServer(w: McpServerWiring): McpServer {
  const server = new McpServer({
    name: "hermes-control-plane",
    version: "1.0.0",
  });

  // ──────────────────────────────────────────────────────────────────────
  // 1. start_coding_task — POST /sessions on the launcher.
  //
  // The single primary entry point. Spawns an E2B sandbox, clones the
  // repo, runs the agent, opens a real GitHub PR authored by the user
  // (P1.1 GITHUB_USER_TOKEN). Returns once the session is created — the
  // actual PR URL is delivered via the events stream (see below).
  // ──────────────────────────────────────────────────────────────────────
  server.registerTool(
    "start_coding_task",
    {
      title: "Start a background coding task",
      description:
        "Spawn an isolated sandbox, run a coding agent on the given task " +
        "against the given GitHub repo, and open a real PR authored by the " +
        "operator. Returns immediately with a sessionId; the PR URL " +
        "arrives later via the pr.created event on the stream.",
      inputSchema: {
        taskDescription: z
          .string()
          .min(5)
          .describe("Plain-English description of the change to make."),
        repoUrl: z
          .string()
          .url()
          .regex(/^https:\/\/github\.com\//, "Only github.com URLs are supported.")
          .describe("HTTPS GitHub repo URL the agent will clone and modify."),
        baseBranch: z
          .string()
          .optional()
          .describe("Base branch to PR against. Defaults to 'main'."),
        projectId: z
          .string()
          .optional()
          .describe(
            "Optional project profile id (selects allowed tools, model). " +
              "Defaults to 'default'.",
          ),
      },
    },
    async (input) => {
      const r = await fetch(`${w.launcherBaseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await r.text();
      if (!r.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `launcher ${r.status}: ${body}` }],
        };
      }
      const data = JSON.parse(body) as {
        sessionId: string;
        sandboxId: string;
        streamUrl?: string;
        stateUrl?: string;
      };
      return {
        content: [
          {
            type: "text",
            text:
              `Started session ${data.sessionId} (sandbox ${data.sandboxId}).\n` +
              `Subscribe to ${data.streamUrl ?? `${w.workerBaseUrl}/sessions/${data.sessionId}/stream`} ` +
              `to receive events. The PR URL arrives as a 'pr.created' event.`,
          },
        ],
        structuredContent: {
          sessionId: data.sessionId,
          sandboxId: data.sandboxId,
          streamUrl: data.streamUrl ?? `${w.workerBaseUrl}/sessions/${data.sessionId}/stream`,
          stateUrl: data.stateUrl ?? `${w.workerBaseUrl}/sessions/${data.sessionId}`,
        },
      };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // 2. get_session_status — GET /sessions/:id on the Worker.
  // ──────────────────────────────────────────────────────────────────────
  server.registerTool(
    "get_session_status",
    {
      title: "Get session status",
      description:
        "Return the current status, event count, and PR URL (if any) for a " +
        "session. Use this to poll progress when you can't subscribe to the " +
        "events stream.",
      inputSchema: {
        sessionId: z
          .string()
          .describe("sessionId returned by start_coding_task."),
      },
    },
    async ({ sessionId }) => {
      const r = await fetch(`${w.workerBaseUrl}/sessions/${sessionId}`);
      const body = await r.text();
      if (!r.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `worker ${r.status}: ${body}` }],
        };
      }
      const data = JSON.parse(body) as {
        session: { id: string; status: string; createdAt: number; updatedAt: number };
        events: unknown[];
        artifacts?: { prUrl?: string };
      };
      const summary =
        `session ${data.session.id} status=${data.session.status} ` +
        `events=${data.events.length}` +
        (data.artifacts?.prUrl ? ` pr=${data.artifacts.prUrl}` : "");
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: {
          status: data.session.status,
          eventCount: data.events.length,
          prUrl: data.artifacts?.prUrl,
        },
      };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // 3. send_followup_prompt — POST /sessions/:id/prompt on the Worker.
  //
  // Sends a follow-up prompt mid-session. If the runner is connected the
  // prompt is delivered immediately; if the sandbox is paused (M5) the
  // Worker returns 202 recoverable and the launcher resumes the sandbox.
  // ──────────────────────────────────────────────────────────────────────
  server.registerTool(
    "send_followup_prompt",
    {
      title: "Send a follow-up prompt to a running session",
      description:
        "Append a new prompt to an existing session. The runner picks it up " +
        "after the current turn (or on resume if the sandbox is paused). " +
        "Returns 202 with recoverable=true when a resume is in flight.",
      inputSchema: {
        sessionId: z.string().describe("sessionId returned by start_coding_task."),
        text: z.string().min(1).describe("Plain-English follow-up prompt."),
      },
    },
    async ({ sessionId, text }) => {
      const r = await fetch(`${w.workerBaseUrl}/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = await r.text();
      if (!r.ok && r.status !== 202) {
        return {
          isError: true,
          content: [{ type: "text", text: `worker ${r.status}: ${body}` }],
        };
      }
      const data = body ? JSON.parse(body) : {};
      return {
        content: [
          {
            type: "text",
            text:
              r.status === 202
                ? `Prompt queued; sandbox resume in flight. ${JSON.stringify(data)}`
                : `Prompt delivered. ${JSON.stringify(data)}`,
          },
        ],
        structuredContent: { status: r.status, ...data },
      };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  // 4. abort_session — DELETE /sessions/:id on the launcher.
  // ──────────────────────────────────────────────────────────────────────
  server.registerTool(
    "abort_session",
    {
      title: "Abort a session",
      description:
        "Cancel a session, kill its sandbox, and mark the session as " +
        "aborted in the event log. Idempotent — safe to call on a session " +
        "that has already terminated.",
      inputSchema: {
        sessionId: z.string().describe("sessionId returned by start_coding_task."),
      },
    },
    async ({ sessionId }) => {
      const r = await fetch(`${w.launcherBaseUrl}/sessions/${sessionId}`, {
        method: "DELETE",
      });
      const body = await r.text().catch(() => "");
      if (!r.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `launcher ${r.status}: ${body}` }],
        };
      }
      return {
        content: [{ type: "text", text: `Aborted ${sessionId}.` }],
        structuredContent: { sessionId, aborted: true },
      };
    },
  );

  return server;
}
