// Unit tests for scripts/validate-agents-md.ts.
//
// The validator runs in CI; testing it directly catches a regression
// that would otherwise only show up the next time AGENTS.md drifts.

import { describe, it, expect } from "vitest";
import { extractScriptMentions, extractMarkdownLinks } from "../scripts/validate-agents-md";

describe("extractScriptMentions", () => {
  it("captures `bun run <script>` mentions and records the line they appeared on", () => {
    const md = [
      "# AGENTS.md", // 1
      "", // 2
      "Run `bun run test` to test.", // 3
      "Then run `bun run typecheck`.", // 4
      "", // 5
      "Also: bun run lint:fix", // 6 (naked, no backticks)
    ].join("\n");
    const mentions = extractScriptMentions(md);
    expect([...mentions.entries()]).toEqual([
      ["test", 3],
      ["typecheck", 4],
      ["lint:fix", 6],
    ]);
  });

  it("deduplicates: only the first line is recorded for each script", () => {
    const md = [
      "Section 1: `bun run test`", // 1
      "Section 2: `bun run test`", // 2
    ].join("\n");
    const mentions = extractScriptMentions(md);
    expect(mentions.get("test")).toBe(1);
    expect(mentions.size).toBe(1);
  });

  it("ignores `bunx <bin>` (not a package.json script)", () => {
    const md = "Run `bunx wrangler dev`.";
    expect(extractScriptMentions(md).size).toBe(0);
  });

  it("handles script names with colons and dashes (e.g. lint:fix, flags:check)", () => {
    const md = "Run `bun run flags:check` then `bun run lint-staged`.";
    const mentions = extractScriptMentions(md);
    expect(mentions.has("flags:check")).toBe(true);
    expect(mentions.has("lint-staged")).toBe(true);
  });
});

describe("extractMarkdownLinks", () => {
  it("captures repo-local markdown links", () => {
    const md = [
      "See [the docs](docs/ARCHITECTURE.md).", // 1
      "Also [contributing](CONTRIBUTING.md).", // 2
    ].join("\n");
    const links = extractMarkdownLinks(md);
    expect(links.get("docs/ARCHITECTURE.md")).toBe(1);
    expect(links.get("CONTRIBUTING.md")).toBe(2);
  });

  it("strips anchors from path links", () => {
    const md = "See [section](docs/foo.md#bar).";
    const links = extractMarkdownLinks(md);
    expect(links.has("docs/foo.md")).toBe(true);
    expect(links.has("docs/foo.md#bar")).toBe(false);
  });

  it("ignores http(s) and mailto links", () => {
    const md = "[external](https://example.com) [mail](mailto:x@y.z) [internal](docs/foo.md)";
    const links = extractMarkdownLinks(md);
    expect(links.size).toBe(1);
    expect(links.has("docs/foo.md")).toBe(true);
  });

  it("ignores anchor-only links", () => {
    const md = "[here](#section) [there](docs/foo.md)";
    const links = extractMarkdownLinks(md);
    expect(links.has("docs/foo.md")).toBe(true);
    expect([...links.keys()]).toEqual(["docs/foo.md"]);
  });

  it("deduplicates: only the first line is recorded for each path", () => {
    const md = "[a](docs/x.md)\n[b](docs/x.md)";
    const links = extractMarkdownLinks(md);
    expect(links.get("docs/x.md")).toBe(1);
    expect(links.size).toBe(1);
  });
});
