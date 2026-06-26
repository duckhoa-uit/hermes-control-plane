// PR #A / A2 — agent-authored PR title + body.
//
// `parsePrMetadata` must be defensively tolerant of LLM output noise
// (prose preamble, ```json fences, trailing whitespace) and reject
// anything we cannot safely render as a PR body.  When parse fails,
// the runner falls back to today's hardcoded title + body, so a `null`
// return here is the "use fallback" signal.

import { describe, it, expect } from "vitest";
import { parsePrMetadata, renderPrBody } from "../src/runner/pr-metadata";

describe("parsePrMetadata", () => {
  const wellFormed = {
    title: "Add formatPercentage helper",
    summary: ["adds formatPercentage(value, digits)", "covers the 50%/12.3% cases requested"],
    verification: "ran `bun run lint` (clean) and the new tests (passing)",
    outOfScope: "did not change call sites; reviewer can adopt incrementally",
  };

  it("parses a well-formed JSON object", () => {
    const p = parsePrMetadata(JSON.stringify(wellFormed));
    expect(p).not.toBeNull();
    expect(p!.title).toBe("Add formatPercentage helper");
    expect(p!.summary).toHaveLength(2);
    expect(p!.verification).toContain("lint");
    expect(p!.outOfScope).toContain("incrementally");
  });

  it("tolerates ```json fences", () => {
    const wrapped = "```json\n" + JSON.stringify(wellFormed) + "\n```";
    const p = parsePrMetadata(wrapped);
    expect(p).not.toBeNull();
    expect(p!.title).toBe("Add formatPercentage helper");
  });

  it("tolerates leading + trailing prose", () => {
    const wrapped =
      "Here is the metadata you asked for:\n\n" +
      JSON.stringify(wellFormed) +
      "\n\nLet me know if you want anything else.";
    const p = parsePrMetadata(wrapped);
    expect(p).not.toBeNull();
    expect(p!.title).toBe("Add formatPercentage helper");
  });

  it("truncates title >72 chars to 69 + ellipsis", () => {
    const longTitle = "A".repeat(120);
    const p = parsePrMetadata(JSON.stringify({ ...wellFormed, title: longTitle }));
    expect(p).not.toBeNull();
    expect(p!.title).toHaveLength(72);
    expect(p!.title.endsWith("...")).toBe(true);
  });

  it("caps summary to 5 bullets", () => {
    const sevenBullets = ["a", "b", "c", "d", "e", "f", "g"];
    const p = parsePrMetadata(JSON.stringify({ ...wellFormed, summary: sevenBullets }));
    expect(p).not.toBeNull();
    expect(p!.summary).toHaveLength(5);
  });

  it("returns null when title is missing", () => {
    const p = parsePrMetadata(JSON.stringify({ ...wellFormed, title: "" }));
    expect(p).toBeNull();
  });

  it("returns null when summary is empty", () => {
    const p = parsePrMetadata(JSON.stringify({ ...wellFormed, summary: [] }));
    expect(p).toBeNull();
  });

  it("returns null on completely unparseable input", () => {
    expect(parsePrMetadata("I cannot do that")).toBeNull();
    expect(parsePrMetadata("")).toBeNull();
    expect(parsePrMetadata("{not json")).toBeNull();
  });

  it("backfills missing verification + outOfScope with friendly placeholders", () => {
    const minimal = { title: "x", summary: ["y"], verification: "", outOfScope: "" };
    const p = parsePrMetadata(JSON.stringify(minimal));
    expect(p).not.toBeNull();
    expect(p!.verification).toBe("(agent did not report verification steps)");
    expect(p!.outOfScope).toBe("(none)");
  });

  it("ignores non-string entries inside summary array", () => {
    const mixed = { ...wellFormed, summary: ["good", 42, null, "also good"] };
    const p = parsePrMetadata(JSON.stringify(mixed));
    expect(p).not.toBeNull();
    expect(p!.summary).toEqual(["good", "also good"]);
  });
});

describe("renderPrBody", () => {
  it("produces the documented Summary / Verification / Out of scope template", () => {
    const meta = {
      title: "Add formatPercentage helper",
      summary: ["adds formatPercentage", "no call site changes"],
      verification: "ran tests",
      outOfScope: "(none)",
    };
    const body = renderPrBody(meta, "Add a formatPercentage helper to src/lib/utils.ts.");
    expect(body).toContain("## Summary");
    expect(body).toContain("- adds formatPercentage");
    expect(body).toContain("## Verification");
    expect(body).toContain("ran tests");
    expect(body).toContain("## Out of scope / Follow-ups");
    expect(body).toContain("(none)");
    expect(body).toContain("hermes-control-plane");
    // Section order — Summary before Verification before Out of scope.
    expect(body.indexOf("## Summary")).toBeLessThan(body.indexOf("## Verification"));
    expect(body.indexOf("## Verification")).toBeLessThan(body.indexOf("## Out of scope"));
  });

  it("truncates task description to 200 chars in the footer", () => {
    const meta = {
      title: "x",
      summary: ["y"],
      verification: "z",
      outOfScope: "w",
    };
    const longTask = "Z".repeat(500);
    const body = renderPrBody(meta, longTask);
    // The footer mentions the task — ensure it does not splat 500 Zs.
    const zCount = (body.match(/Z/g) ?? []).length;
    expect(zCount).toBeLessThanOrEqual(200);
  });
});
