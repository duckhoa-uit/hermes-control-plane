import { describe, it, expect, vi, beforeEach } from "vitest";
import { trackApproval } from "../src/core/observability";

describe("observability.trackApproval", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is a no-op when observability is not configured", () => {
    const spy = vi.fn();
    globalThis.fetch = spy as any;
    trackApproval({
      event: "approval_requested",
      approvalId: "a1",
      sessionId: "s1",
      type: "exec",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts a PostHog capture payload when configured", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = spy as any;
    trackApproval(
      {
        event: "approval_resolved",
        approvalId: "a2",
        sessionId: "s2",
        type: "git_push",
        decision: "once",
        actor: "user@x",
        latencyMs: 1234,
      },
      { host: "https://ph.example.com", token: "phc_token" },
    );

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://ph.example.com/capture/");
    expect((init as any).method).toBe("POST");
    expect((init as any).headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse((init as any).body);
    expect(body.api_key).toBe("phc_token");
    expect(body.event).toBe("hermes_approval");
    expect(body.properties.approval_event).toBe("approval_resolved");
    expect(body.properties.approval_id).toBe("a2");
    expect(body.properties.distinct_id).toBe("s2");
    expect(body.properties.approval_type).toBe("git_push");
    expect(body.properties.decision).toBe("once");
    expect(body.properties.actor).toBe("user@x");
    expect(body.properties.latency_ms).toBe(1234);
    expect(body.properties.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults missing fields when posting", () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = spy as any;
    trackApproval(
      {
        event: "approval_timeout",
        approvalId: "a3",
        sessionId: "s3",
        type: "exec",
      },
      { host: "https://ph.example.com", token: "phc_token" },
    );

    const body = JSON.parse((spy.mock.calls[0]![1] as any).body);
    expect(body.properties.decision).toBe("n/a");
    expect(body.properties.actor).toBe("system");
    expect(body.properties.latency_ms).toBe(0);
  });

  it("swallows fetch rejection without throwing", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network")) as any;
    expect(() =>
      trackApproval(
        {
          event: "hardline_block",
          approvalId: "a4",
          sessionId: "s4",
          type: "exec",
        },
        { host: "https://ph.example.com", token: "phc_token" },
      ),
    ).not.toThrow();
    // Give the rejected promise time to settle
    await new Promise((r) => setTimeout(r, 0));
  });

  it("does not retain observability state between calls", () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = spy as any;
    trackApproval(
      {
        event: "approval_requested",
        approvalId: "a5",
        sessionId: "s5",
        type: "exec",
      },
      { host: "", token: "" },
    );
    // Empty configuration is a no-op and does not leak state from another call.
    expect(spy).not.toHaveBeenCalled();
  });

  it("hands the delivery promise to waitUntil when a runtime provides it", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = spy as any;
    const waitUntil = vi.fn();

    const request = trackApproval(
      {
        event: "approval_requested",
        approvalId: "a6",
        sessionId: "s6",
        type: "exec",
      },
      { host: "https://ph.example.com", token: "phc_token", waitUntil },
    );

    expect(request).toBeDefined();
    expect(waitUntil).toHaveBeenCalledWith(request);
    await request;
  });
});
