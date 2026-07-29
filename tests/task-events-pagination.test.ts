import { describe, expect, it } from "vitest";
import { parseEventCursor } from "../src/app";

describe("event pagination input", () => {
  it("falls back for malformed values and normalizes valid cursors", () => {
    expect(parseEventCursor(undefined, 100)).toBe(100);
    expect(parseEventCursor("abc", 100)).toBe(100);
    expect(parseEventCursor("-1", 100)).toBe(100);
    expect(parseEventCursor("12.9", 100)).toBe(12);
    expect(parseEventCursor("500", 100)).toBe(500);
  });
});
