// Orphan sweeper: only kills sandboxes whose hermes session is terminal or
// unknown, and only those with the hermes_session_id metadata tag.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { sweepOrphans } from "../src/launcher/sweeper";

const killSpy = vi.fn(async (_id: string) => {});

vi.mock("../src/launcher/provision", () => ({
  killSandbox: (_apiKey: string, id: string) => killSpy(id),
}));

const realFetch = global.fetch;

describe("sweepOrphans", () => {
  beforeEach(() => {
    killSpy.mockClear();
  });

  it("kills sandboxes tagged with terminal sessions, keeps running ones, ignores untagged", async () => {
    const sandboxes = [
      { sandboxID: "sbx_done", metadata: { hermes_session_id: "sess_done" } },
      { sandboxID: "sbx_run", metadata: { hermes_session_id: "sess_run" } },
      { sandboxID: "sbx_404", metadata: { hermes_session_id: "sess_404" } },
      { sandboxID: "sbx_untagged" }, // no metadata
      { sandboxID: "sbx_other", metadata: { other: "x" } }, // tagged differently
    ];

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v2/sandboxes")) {
        return new Response(JSON.stringify(sandboxes), { status: 200 });
      }
      if (url.includes("/sessions/sess_done")) {
        return new Response(JSON.stringify({ session: { status: "completed" } }), { status: 200 });
      }
      if (url.includes("/sessions/sess_run")) {
        return new Response(JSON.stringify({ session: { status: "running" } }), { status: 200 });
      }
      if (url.includes("/sessions/sess_404")) {
        return new Response("not found", { status: 404 });
      }
      return new Response("unhandled", { status: 500 });
    }) as typeof fetch;

    const result = await sweepOrphans({
      e2bAuth: "key",
      hermesBaseUrl: "http://worker",
    });

    expect(result.scanned).toBe(3); // 3 tagged with hermes_session_id
    expect(result.killed.toSorted()).toEqual(["sbx_404", "sbx_done"]);
    expect(result.kept).toEqual(["sbx_run"]);
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy.mock.calls.map((c) => c[0]).toSorted()).toEqual(["sbx_404", "sbx_done"]);

    global.fetch = realFetch;
  });

  it("kills sandboxes whose session is archived (merge webhook race)", async () => {
    const sandboxes = [{ sandboxID: "sbx_arch", metadata: { hermes_session_id: "sess_arch" } }];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v2/sandboxes")) {
        return new Response(JSON.stringify(sandboxes), { status: 200 });
      }
      if (url.includes("/sessions/sess_arch")) {
        return new Response(JSON.stringify({ session: { status: "archived" } }), { status: 200 });
      }
      return new Response("unhandled", { status: 500 });
    }) as typeof fetch;

    const result = await sweepOrphans({ e2bAuth: "key", hermesBaseUrl: "http://worker" });
    expect(result.killed).toEqual(["sbx_arch"]);
    expect(result.kept).toEqual([]);
    expect(killSpy).toHaveBeenCalledWith("sbx_arch");
    global.fetch = realFetch;
  });

  it("keeps sandboxes when Worker is unreachable (does not destructively act on uncertainty)", async () => {
    const sandboxes = [{ sandboxID: "sbx_a", metadata: { hermes_session_id: "sess_a" } }];

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v2/sandboxes")) {
        return new Response(JSON.stringify(sandboxes), { status: 200 });
      }
      // Worker 5xx -> simulate transient outage
      return new Response("oops", { status: 503 });
    }) as typeof fetch;

    const result = await sweepOrphans({
      e2bAuth: "key",
      hermesBaseUrl: "http://worker",
    });
    expect(result.killed).toEqual([]);
    expect(result.kept).toEqual(["sbx_a"]);
    expect(killSpy).not.toHaveBeenCalled();
    global.fetch = realFetch;
  });
});
