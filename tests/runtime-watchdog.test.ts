import { describe, expect, it, vi } from "vitest";
import type { FlueObservation } from "@flue/runtime";
import { createModelProgressWatchdog } from "../src/agent/runtime-watchdog";
import { WatchdogTimeoutError } from "../src/agent/watchdog";

describe("model progress watchdog", () => {
  it("rejects a model turn that stops emitting progress", async () => {
    vi.useFakeTimers();
    const instrumentation = createModelProgressWatchdog(() => 1_000);
    try {
      const promise = instrumentation.interceptor(
        { type: "model", turnId: "turn-1" },
        {},
        () => new Promise(() => {}),
      );
      const rejection = expect(promise).rejects.toBeInstanceOf(WatchdogTimeoutError);

      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    } finally {
      await instrumentation.dispose();
      vi.useRealTimers();
    }
  });

  it("resets the inactivity deadline when the model emits progress", async () => {
    vi.useFakeTimers();
    const instrumentation = createModelProgressWatchdog(() => 1_000);
    try {
      const promise = instrumentation.interceptor(
        { type: "model", turnId: "turn-2" },
        {},
        () => new Promise(() => {}),
      );
      const rejection = expect(promise).rejects.toBeInstanceOf(WatchdogTimeoutError);

      await vi.advanceTimersByTimeAsync(800);
      instrumentation.observe(
        {
          type: "thinking_delta",
          turnId: "turn-2",
        } as FlueObservation,
        {} as never,
      );
      await vi.advanceTimersByTimeAsync(800);

      let settled = false;
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      await rejection;
    } finally {
      await instrumentation.dispose();
      vi.useRealTimers();
    }
  });
});
