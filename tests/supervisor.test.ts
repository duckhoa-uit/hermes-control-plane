// The supervisor (src/runner/supervisor.ts) is mostly side-effectful glue:
//   - spawn opencode serve, wait for "listening" line in log
//   - poll /opt/hermes/start.json
//   - PUT /auth/zai-coding-plan with ZAI_API_KEY
//   - spawn runner.js
//   - if either child exits, kill the other
//
// Spawning real child processes is out of scope for unit tests. Instead we
// extract the testable seams (auth call + babysitter) into the module
// surface and verify those. The full integration is covered by the live
// e2e run in M4 step 8.
//
// For M4 PR the contract we want to lock is the babysit behavior — a
// regression here would leak sandbox compute.

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

// We're going to import a small helper that the supervisor exports for
// this purpose. Keep the test trivially executable.

// Fake ChildProcess: emits exit when we call .die().
class FakeChild extends EventEmitter {
  killed = false;
  kill(sig: NodeJS.Signals): boolean {
    if (this.killed) return true;
    this.killed = true;
    setImmediate(() => this.emit("exit", null, sig));
    return true;
  }
  die(code: number): void {
    setImmediate(() => this.emit("exit", code, null));
  }
}

describe("supervisor babysit semantics", () => {
  it("kills the peer when one child exits", async () => {
    const { babysitForTests } = await import("../src/runner/supervisor-helpers");
    const a = new FakeChild();
    const b = new FakeChild();
    const exitCode: { value: number | null } = { value: null };
    babysitForTests(a as never, b as never, (c) => { exitCode.value = c; });

    a.die(7);
    // Wait two macrotask ticks for the chain (exit -> kill -> peer exit).
    await new Promise((r) => setTimeout(r, 20));
    expect(b.killed).toBe(true);
    expect(exitCode.value).toBe(7);
  });

  it("works the other way too (runner exits first)", async () => {
    const { babysitForTests } = await import("../src/runner/supervisor-helpers");
    const serve = new FakeChild();
    const runner = new FakeChild();
    const exitCode: { value: number | null } = { value: null };
    babysitForTests(serve as never, runner as never, (c) => { exitCode.value = c; });

    runner.die(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(serve.killed).toBe(true);
    expect(exitCode.value).toBe(0);
  });

  it("does not call exit twice if both children die back-to-back", async () => {
    const { babysitForTests } = await import("../src/runner/supervisor-helpers");
    const a = new FakeChild();
    const b = new FakeChild();
    const exits: Array<number | null> = [];
    babysitForTests(a as never, b as never, (c) => { exits.push(c); });

    a.die(3);
    b.die(99);
    await new Promise((r) => setTimeout(r, 30));
    expect(exits).toEqual([3]);
  });
});

describe("supervisor auth.set", () => {
  it("PUTs /auth/zai-coding-plan with the api key", async () => {
    const { applyZaiAuthForTests } = await import("../src/runner/supervisor-helpers");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("true", { status: 200 });
    });
    await applyZaiAuthForTests("http://127.0.0.1:4096", "k-123", fakeFetch);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:4096/auth/zai-coding-plan");
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ type: "api", key: "k-123" });
  });

  it("throws when the server returns non-2xx", async () => {
    const { applyZaiAuthForTests } = await import("../src/runner/supervisor-helpers");
    const fakeFetch = async () => new Response("nope", { status: 500 });
    await expect(applyZaiAuthForTests("http://x", "k", fakeFetch)).rejects.toThrow(/auth\.set failed/);
  });
});
