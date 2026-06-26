import { describe, it, expect } from "vitest";
import {
  canTransition,
  assertTransition,
  InvalidTransitionError,
  getValidTransitions,
  isTerminal,
  isActive,
} from "../src/core/state-machine";
import type { SessionStatus } from "../src/core/types";

describe("state-machine", () => {
  describe("canTransition", () => {
    it("allows created -> provisioning", () => {
      expect(canTransition("created", "provisioning")).toBe(true);
    });

    it("allows running -> needs_approval", () => {
      expect(canTransition("running", "needs_approval")).toBe(true);
    });

    it("allows running -> review_ready", () => {
      expect(canTransition("running", "review_ready")).toBe(true);
    });

    it("allows needs_approval -> running", () => {
      expect(canTransition("needs_approval", "running")).toBe(true);
    });

    it("allows review_ready -> creating_pr", () => {
      expect(canTransition("review_ready", "creating_pr")).toBe(true);
    });

    it("allows review_ready -> running for follow-up prompts (M4)", () => {
      expect(canTransition("review_ready", "running")).toBe(true);
    });

    it("allows creating_pr -> completed", () => {
      expect(canTransition("creating_pr", "completed")).toBe(true);
    });

    it("allows completed -> archived", () => {
      expect(canTransition("completed", "archived")).toBe(true);
    });

    it("allows running -> failed", () => {
      expect(canTransition("running", "failed")).toBe(true);
    });

    it("denies created -> running (skip provisioning)", () => {
      expect(canTransition("created", "running")).toBe(false);
    });

    it("denies completed -> running", () => {
      expect(canTransition("completed", "running")).toBe(false);
    });

    it("denies archived -> anything", () => {
      const allStates: SessionStatus[] = [
        "created",
        "provisioning",
        "runner_connecting",
        "ready",
        "running",
        "needs_approval",
        "review_ready",
        "creating_pr",
        "completed",
        "failed",
        "aborted",
        "stalled",
        "archived",
      ];
      for (const s of allStates) {
        expect(canTransition("archived", s)).toBe(false);
      }
    });

    it("allows stalled -> running (recovery)", () => {
      expect(canTransition("stalled", "running")).toBe(true);
    });

    it("allows stalled -> failed", () => {
      expect(canTransition("stalled", "failed")).toBe(true);
    });
  });

  describe("assertTransition", () => {
    it("passes for valid transition", () => {
      expect(() => assertTransition("created", "provisioning")).not.toThrow();
    });

    it("throws InvalidTransitionError for invalid", () => {
      expect(() => assertTransition("created", "running")).toThrow(InvalidTransitionError);
    });

    it("error contains from/to in message", () => {
      try {
        assertTransition("completed", "running");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidTransitionError);
        expect((e as InvalidTransitionError).from).toBe("completed");
        expect((e as InvalidTransitionError).to).toBe("running");
      }
    });
  });

  describe("getValidTransitions", () => {
    it("returns valid targets for running", () => {
      const targets = getValidTransitions("running");
      expect(targets).toContain("needs_approval");
      expect(targets).toContain("review_ready");
      expect(targets).toContain("failed");
      expect(targets).toContain("completed");
    });

    it("returns empty for archived", () => {
      expect(getValidTransitions("archived")).toEqual([]);
    });
  });

  describe("isTerminal", () => {
    it("returns true for completed, failed, aborted", () => {
      expect(isTerminal("completed")).toBe(true);
      expect(isTerminal("failed")).toBe(true);
      expect(isTerminal("aborted")).toBe(true);
    });

    it("returns false for active states", () => {
      expect(isTerminal("running")).toBe(false);
      expect(isTerminal("provisioning")).toBe(false);
      expect(isTerminal("created")).toBe(false);
    });
  });

  describe("isActive", () => {
    it("returns true for running", () => {
      expect(isActive("running")).toBe(true);
    });

    it("returns false for completed", () => {
      expect(isActive("completed")).toBe(false);
    });

    it("returns false for created (pre-provisioning)", () => {
      expect(isActive("created")).toBe(false);
    });
  });
});
