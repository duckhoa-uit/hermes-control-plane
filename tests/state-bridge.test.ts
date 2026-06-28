import { describe, it, expect } from "vitest";
import { lifecycleToStatus, applyLifecycleEvent, advanceStatus } from "../src/agent/state-bridge";
import { canTransition, isTerminal } from "../src/core/state-machine";

describe("state-bridge", () => {
  describe("lifecycleToStatus", () => {
    it("maps created → created", () => {
      expect(lifecycleToStatus("created")).toBe("created");
    });
    it("maps submitted → provisioning", () => {
      expect(lifecycleToStatus("submitted")).toBe("provisioning");
    });
    it("maps running → running", () => {
      expect(lifecycleToStatus("running")).toBe("running");
    });
    it("maps needs_input → needs_approval", () => {
      expect(lifecycleToStatus("needs_input")).toBe("needs_approval");
    });
    it("maps completed → completed", () => {
      expect(lifecycleToStatus("completed")).toBe("completed");
    });
    it("maps failed → failed", () => {
      expect(lifecycleToStatus("failed")).toBe("failed");
    });
    it("maps aborted → aborted", () => {
      expect(lifecycleToStatus("aborted")).toBe("aborted");
    });
  });

  describe("applyLifecycleEvent", () => {
    it("transitions created → provisioning via submitted", () => {
      const next = applyLifecycleEvent("created", "submitted");
      expect(next).toBe("provisioning");
    });

    it("transitions provisioning → running", () => {
      const next = applyLifecycleEvent("provisioning", "running");
      expect(next).toBe("running");
    });

    it("transitions running → needs_approval", () => {
      const next = applyLifecycleEvent("running", "needs_input");
      expect(next).toBe("needs_approval");
    });

    it("transitions running → completed", () => {
      const next = applyLifecycleEvent("running", "completed");
      expect(next).toBe("completed");
    });

    it("returns running on follow-up submission while running", () => {
      const next = applyLifecycleEvent("running", "submitted");
      expect(next).toBe("running");
    });

    it("transitions review_ready → running for follow-up", () => {
      const next = applyLifecycleEvent("review_ready", "running");
      expect(next).toBe("running");
    });

    it("transitions completed → archived via completed event", () => {
      const next = applyLifecycleEvent("completed", "completed");
      expect(next).toBe("archived");
    });

    it("transitions failed → archived via completed event", () => {
      const next = applyLifecycleEvent("failed", "completed");
      expect(next).toBe("archived");
    });

    it("throws on invalid transition", () => {
      expect(() => applyLifecycleEvent("completed", "running")).toThrow();
    });
  });

  describe("advanceStatus", () => {
    it("advances valid transitions", () => {
      expect(advanceStatus("created", "provisioning")).toBe("provisioning");
      expect(advanceStatus("provisioning", "running")).toBe("running");
      expect(advanceStatus("running", "review_ready")).toBe("review_ready");
    });

    it("throws on invalid transitions", () => {
      expect(() => advanceStatus("completed", "running")).toThrow();
    });
  });

  describe("state-machine compatibility", () => {
    it("all transition paths from lifecycle are valid", () => {
      const lifecycleStates = [
        "created",
        "submitted",
        "running",
        "needs_input",
        "completed",
        "failed",
        "aborted",
      ] as const;
      for (const ls of lifecycleStates) {
        const status = lifecycleToStatus(ls);
        expect(typeof status).toBe("string");
      }
    });

    it("terminal states are terminal", () => {
      expect(isTerminal("completed")).toBe(true);
      expect(isTerminal("failed")).toBe(true);
      expect(isTerminal("aborted")).toBe(true);
      expect(isTerminal("running")).toBe(false);
    });
  });
});
