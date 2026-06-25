// ============================================================
// MCP send_followup_prompt — transparent re-provision flow.
//
// Verifies the three flows:
//   (a) session non-terminal -> forwards to Worker POST /sessions/:id/prompt
//   (b) session terminal + PR open -> POSTs to launcher /sessions with
//       parentSessionId and returns newSessionId in structuredContent
//   (c) session terminal + PR not in index / merged -> isError
//
// We don't spin up the real MCP transport (StreamableHTTP). Instead we
// pull the tool out of the McpServer instance and invoke its handler
// directly. The MCP SDK exposes registerTool's handler internally as
// `tool._callback`; we use a stable accessor via private API to keep the
// test focused on our logic, not on transport plumbing.
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { buildMcpHandler } from "../src/mcp/server";

const WORKER = "http://worker.test";
const LAUNCHER = "http://launcher.test";

type FetchHandler = (input: Request) => Promise<Response>;

function withFetchMock(handler: FetchHandler, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return handler(req);
  };
  return fn().finally(() => { globalThis.fetch = orig; });
}

async function callTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<Response> {
  const handler = buildMcpHandler({ workerBaseUrl: WORKER, launcherBaseUrl: LAUNCHER, log: () => {} });
  // JSON-RPC tools/call envelope (Streamable HTTP, stateless mode).
  const req = new Request("http://mcp.local/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // accept hint required by the transport in stateless mode
      "accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  return await handler(req);
}

beforeEach(() => { /* noop */ });

describe("MCP send_followup_prompt", () => {
  it("(a) non-terminal session -> forwards to Worker prompt and returns 200", async () => {
    let promptCalled = false;
    const handler: FetchHandler = async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/sessions/sess-1") {
        return Response.json({ session: { status: "running" }, artifacts: {} });
      }
      if (req.method === "POST" && url.pathname === "/sessions/sess-1/prompt") {
        promptCalled = true;
        return Response.json({ ok: true });
      }
      return Response.json({ error: `unexpected ${req.method} ${url.pathname}` }, { status: 500 });
    };
    await withFetchMock(handler, async () => {
      const resp = await callTool("send_followup_prompt", { sessionId: "sess-1", text: "next step" });
      const body = (await resp.json()) as any;
      expect(body.result.isError).toBeFalsy();
      expect(promptCalled).toBe(true);
      const structured = body.result.structuredContent;
      expect(structured.sessionId).toBe("sess-1");
      expect(structured.status).toBe(200);
    });
  });

  it("(b) terminal + open PR -> launcher /sessions with parentSessionId, returns newSessionId", async () => {
    let launcherCalled: any = null;
    const handler: FetchHandler = async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/sessions/sess-old") {
        return Response.json({
          session: { id: "sess-old", status: "completed", branch: "hermes/abcd" },
          artifacts: { prUrl: "https://github.com/o/r/pull/5" },
          repoUrl: "https://github.com/o/r",
          baseBranch: "main",
        });
      }
      if (req.method === "POST" && url.pathname === "/sessions") {
        launcherCalled = await req.json();
        return Response.json({
          sessionId: "sess-new",
          sandboxId: "sbx-new",
          streamUrl: `${WORKER}/sessions/sess-new/stream`,
          prMode: { branch: "hermes/abcd", prNumber: 5, prUrl: "https://github.com/o/r/pull/5" },
        }, { status: 201 });
      }
      return Response.json({ error: `unexpected ${req.method} ${url.pathname}` }, { status: 500 });
    };
    await withFetchMock(handler, async () => {
      const resp = await callTool("send_followup_prompt", { sessionId: "sess-old", text: "tweak the title" });
      const body = (await resp.json()) as any;
      expect(body.result.isError).toBeFalsy();
      expect(launcherCalled).toMatchObject({ parentSessionId: "sess-old", taskDescription: "tweak the title" });
      const structured = body.result.structuredContent;
      expect(structured.newSessionId).toBe("sess-new");
      expect(structured.parentSessionId).toBe("sess-old");
      expect(structured.prMode?.prNumber).toBe(5);
    });
  });

  it("(c) terminal + PR not in index (merged/closed) -> isError", async () => {
    const handler: FetchHandler = async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/sessions/sess-merged") {
        return Response.json({
          session: { id: "sess-merged", status: "archived", branch: "hermes/x" },
          artifacts: { prUrl: "https://github.com/o/r/pull/9" },
          repoUrl: "https://github.com/o/r",
          baseBranch: "main",
        });
      }
      if (req.method === "POST" && url.pathname === "/sessions") {
        return Response.json(
          { error: "PR no longer indexed", reason: "merged" },
          { status: 410 },
        );
      }
      return Response.json({ error: `unexpected ${req.method} ${url.pathname}` }, { status: 500 });
    };
    await withFetchMock(handler, async () => {
      const resp = await callTool("send_followup_prompt", { sessionId: "sess-merged", text: "hi" });
      const body = (await resp.json()) as any;
      expect(body.result.isError).toBe(true);
      const text = body.result.content[0].text as string;
      expect(text).toMatch(/410/);
      expect(text).toMatch(/start_coding_task/);
    });
  });
});
