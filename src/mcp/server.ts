// MCP (Model Context Protocol) server bundled into the control-plane-launcher.
//
// Exposes hermes-control-plane as a single MCP server with four tools the
// Hermes Agent (and any other MCP host) can call. Mounted on the launcher's
// /mcp endpoint (same port as the launcher's HTTP API), so a single
// Cloudflare Tunnel covers both surfaces.
//
// Hermes Agent integration (user-side ~/.hermes/config.yaml):
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
  /** Shared secret sent on `x-hermes-launcher-secret` for launcher REST
   *  calls (POST /sessions, DELETE /sessions/:id). Matches the launcher's
   *  HERMES_LAUNCHER_SECRET env. */
  launcherSecret: string;
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
        branchSuffix: z
          .string()
          .regex(/^[a-z0-9-]{1,40}$/, "lowercase alphanumeric + hyphens, 1-40 chars")
          .optional()
          .describe(
            "Optional short slug derived from the task (e.g. 'add-rate-limit-middleware'). " +
              "Used as the branch suffix so reviewers see a meaningful branch name. " +
              "Validated server-side; invalid values are silently ignored.",
          ),
      },
    },
    async (input) => {
      const r = await fetch(`${w.launcherBaseUrl}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hermes-launcher-secret": w.launcherSecret,
        },
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
  // 3. send_followup_prompt — three flows depending on session state:
  //
  //   a. session running / paused — POST /sessions/:id/prompt on the
  //      Worker (the existing M5 path; sandbox resumes if paused).
  //   b. session terminal AND its PR is still open in PR_INDEX_DO —
  //      transparently spawn a NEW session in amend mode against the
  //      same PR via POST /sessions on the launcher with parentSessionId.
  //      The new sessionId is returned so the agent can track the
  //      follow-up turn.
  //   c. session terminal AND no open PR — return an error explaining
  //      the user should start a fresh session.
  //
  // Transparent re-provision is the design intent (see plan §3). The
  // caller does not need to know whether the existing sandbox was
  // reused or a fresh one was spawned; the structuredContent carries
  // newSessionId when a spawn happened.
  // ──────────────────────────────────────────────────────────────────────
  server.registerTool(
    "send_followup_prompt",
    {
      title: "Send a follow-up prompt to a running session",
      description:
        "Append a new prompt to an existing session. If the session is still " +
        "running, the prompt is delivered after the current turn (or on " +
        "resume if the sandbox is paused). If the session already ended " +
        "(completed/failed/aborted) AND its PR is still open, a fresh " +
        "session is transparently spawned in amend mode to push another " +
        "commit onto the same PR — the new sessionId is returned. If the " +
        "PR was merged or closed, the call fails with a 410. " +
        "IMPORTANT: when this call spawns a new amend session, the returned " +
        "sessionId is in `provisioning`/`runner_connecting` state — the " +
        "runner has NOT yet connected. Subscribe to streamUrl and wait for " +
        "`session.status_changed -> ready` before calling " +
        "send_followup_prompt against the new sessionId; otherwise the " +
        "prompt will be queued behind the spawn's initial task and the two " +
        "agent.prompt commands may race when the runner finally connects.",
      inputSchema: {
        sessionId: z.string().describe("sessionId returned by start_coding_task."),
        text: z.string().min(1).describe("Plain-English follow-up prompt."),
      },
    },
    async ({ sessionId, text }) => {
      // 1. Inspect the session.
      const stateResp = await fetch(`${w.workerBaseUrl}/sessions/${sessionId}`);
      if (!stateResp.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `worker ${stateResp.status}: ${await stateResp.text()}` }],
        };
      }
      const state = (await stateResp.json()) as {
        session?: { status: string } | null;
        artifacts?: { prUrl?: string } | null;
      };
      const status = state.session?.status ?? "unknown";
      const TERMINAL = new Set(["completed", "failed", "aborted", "archived"]);

      if (!TERMINAL.has(status)) {
        // Flow (a): forward to the existing prompt path.
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
          structuredContent: { status: r.status, sessionId, ...data },
        };
      }

      // Terminal: try the amend path. Re-provision will fail with a clear
      // reason if the PR is no longer open / never existed.
      w.log(
        `[mcp] send_followup_prompt: session ${sessionId.slice(0, 8)} is ${status}; ` +
        `attempting transparent amend re-provision`,
      );
      const provResp = await fetch(`${w.launcherBaseUrl}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hermes-launcher-secret": w.launcherSecret,
        },
        body: JSON.stringify({ parentSessionId: sessionId, taskDescription: text }),
      });
      const provBody = await provResp.text();
      if (!provResp.ok) {
        // 410 = PR merged/closed/missing — explain and tell the caller to
        // start a fresh session via start_coding_task.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Cannot follow up: session ${sessionId} is ${status} and ` +
                `amend re-provision failed (${provResp.status}): ${provBody}. ` +
                `Use start_coding_task to begin a new session.`,
            },
          ],
        };
      }
      const data = JSON.parse(provBody) as {
        sessionId: string;
        sandboxId: string;
        streamUrl?: string;
        prMode?: { branch: string; prNumber: number; prUrl: string } | null;
      };
      return {
        content: [
          {
            type: "text",
            text:
              `Spawned amend session ${data.sessionId} (sandbox ${data.sandboxId})` +
              (data.prMode ? ` amending ${data.prMode.prUrl}` : "") +
              `. Subscribe to ${data.streamUrl ?? `${w.workerBaseUrl}/sessions/${data.sessionId}/stream`} ` +
              `for the new pr.updated event.`,
          },
        ],
        structuredContent: {
          status: provResp.status,
          parentSessionId: sessionId,
          newSessionId: data.sessionId,
          sandboxId: data.sandboxId,
          streamUrl: data.streamUrl,
          prMode: data.prMode ?? undefined,
        },
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
        headers: { "x-hermes-launcher-secret": w.launcherSecret },
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
