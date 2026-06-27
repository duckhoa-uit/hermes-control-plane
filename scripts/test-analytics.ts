#!/usr/bin/env bun
// Test analytics summarizer.
//
// Parses the JUnit XML produced by `vitest run --reporter=junit`
// (reports/junit.xml) and renders a GitHub-flavoured-markdown summary
// that the `tests` workflow appends to `$GITHUB_STEP_SUMMARY`. The
// summary covers the three Agent Readiness signals we care about:
//
//   * Test performance — total + per-test durations, top-N slowest.
//   * Flaky test detection — surface any <testcase> that contains a
//     <rerunFailure> element (vitest emits these when `retry: 2`
//     turns a red test green on a subsequent attempt).
//   * Pass/fail summary — totals, broken down by file, so the run page
//     doesn't have to expand the log.
//
// Why a one-shot script instead of an action?
//   - The JUnit shape vitest emits is stable across versions; we don't
//     need a 700 KB dependency to parse a few attributes.
//   - The output is human-readable markdown — no JSON-to-markdown
//     hop, no formatter ambiguity. The action ecosystem (e.g. dorny/
//     test-reporter) is geared for the GitHub UI's "Checks" tab, not
//     the run summary; both surfaces matter so we keep them separate.
//
// Usage:
//   bun run scripts/test-analytics.ts reports/junit.xml >> $GITHUB_STEP_SUMMARY
//
// Exits 0 on success, 1 if the report is missing/unparseable.

import { existsSync, readFileSync } from "node:fs";

const SLOW_TEST_COUNT = 10; // top-N slowest tests we surface.
const SLOW_MS_THRESHOLD = 300; // matches vitest.config.ts slowTestThreshold.

interface TestCase {
  classname: string; // file path
  name: string;
  durationMs: number;
  status: "passed" | "failed" | "skipped";
  retried: number; // count of <rerunFailure> children
  failureMessage?: string;
}

interface Summary {
  files: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
  cases: TestCase[];
}

function main() {
  const file = process.argv[2] ?? "reports/junit.xml";
  if (!existsSync(file)) {
    process.stdout.write(`## Tests + coverage\n\n_No junit report found at \`${file}\`._\n`);
    process.exit(0); // a missing report shouldn't fail the workflow's summary step
  }
  const xml = readFileSync(file, "utf8");
  const summary = parse(xml);
  render(summary);
}

function parse(xml: string): Summary {
  const cases: TestCase[] = [];
  // Match each <testcase ...>...</testcase> block (self-closing OR with body).
  // Vitest emits two shapes: <testcase .../> for passing, and
  // <testcase ...>...<failure/skipped/rerunFailure/></testcase> for the rest.
  const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let match: RegExpExecArray | null;
  while ((match = caseRe.exec(xml))) {
    const attrs = match[1];
    const body = match[2] ?? "";
    const classname = attr(attrs, "classname") ?? "(unknown)";
    const name = attr(attrs, "name") ?? "(unnamed)";
    const time = Number.parseFloat(attr(attrs, "time") ?? "0");
    const durationMs = Number.isFinite(time) ? time * 1000 : 0;

    let status: TestCase["status"] = "passed";
    let failureMessage: string | undefined;
    if (/<skipped\b/.test(body)) {
      status = "skipped";
    } else if (/<failure\b/.test(body) || /<error\b/.test(body)) {
      status = "failed";
      const failMatch = body.match(/<failure\b[^>]*message="([^"]*)"/);
      failureMessage = failMatch?.[1];
    }
    const retried = (body.match(/<rerunFailure\b/g) ?? []).length;

    cases.push({ classname, name, durationMs, status, retried, failureMessage });
  }

  // Pull totals straight from the root <testsuites> attributes when
  // present — vitest fills them in and they're cheaper than recounting.
  const rootMatch = xml.match(/<testsuites\b([^>]*)>/);
  const rootAttrs = rootMatch?.[1] ?? "";
  const total = num(attr(rootAttrs, "tests")) ?? cases.length;
  const failures =
    num(attr(rootAttrs, "failures")) ?? cases.filter((c) => c.status === "failed").length;
  const skipped =
    num(attr(rootAttrs, "skipped")) ?? cases.filter((c) => c.status === "skipped").length;
  const durationS = Number.parseFloat(attr(rootAttrs, "time") ?? "0");

  const files = new Set(cases.map((c) => c.classname)).size;
  const flaky = cases.filter((c) => c.retried > 0 && c.status === "passed").length;

  return {
    files,
    total,
    passed: total - failures - skipped,
    failed: failures,
    skipped,
    flaky,
    durationMs: Number.isFinite(durationS) ? durationS * 1000 : 0,
    cases,
  };
}

function render(s: Summary) {
  const lines: string[] = [];
  lines.push("## Tests + coverage");
  lines.push("");
  lines.push(
    `**${s.total}** tests across **${s.files}** files in **${fmt(s.durationMs)}** — ` +
      `passed: ${s.passed}, failed: ${s.failed}, skipped: ${s.skipped}, flaky: ${s.flaky}.`,
  );
  lines.push("");

  if (s.flaky > 0) {
    lines.push("### :warning: Flaky tests (green after retry)");
    lines.push("");
    lines.push("| File | Test | Retries |");
    lines.push("|---|---|---|");
    for (const flake of s.cases.filter((tc) => tc.retried > 0 && tc.status === "passed")) {
      lines.push(`| \`${flake.classname}\` | ${escape(flake.name)} | ${flake.retried} |`);
    }
    lines.push("");
  }

  if (s.failed > 0) {
    lines.push("### :x: Failed tests");
    lines.push("");
    lines.push("| File | Test | Message |");
    lines.push("|---|---|---|");
    for (const fail of s.cases.filter((tc) => tc.status === "failed").slice(0, 20)) {
      lines.push(
        `| \`${fail.classname}\` | ${escape(fail.name)} | ${escape(fail.failureMessage ?? "")} |`,
      );
    }
    lines.push("");
  }

  // Slow tests — always emitted so a single regression is visible
  // against the previous run.
  const slow = s.cases
    .filter((c) => c.durationMs >= SLOW_MS_THRESHOLD)
    .toSorted((a, b) => b.durationMs - a.durationMs)
    .slice(0, SLOW_TEST_COUNT);
  if (slow.length > 0) {
    lines.push(`### :snail: Slow tests (\`> ${SLOW_MS_THRESHOLD} ms\`)`);
    lines.push("");
    lines.push("| File | Test | Duration |");
    lines.push("|---|---|---|");
    for (const c of slow) {
      lines.push(`| \`${c.classname}\` | ${escape(c.name)} | ${fmt(c.durationMs)} |`);
    }
    lines.push("");
  }

  process.stdout.write(lines.join("\n"));
  process.stdout.write("\n");
}

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m?.[1];
}

function num(s: string | undefined): number | undefined {
  if (s == null) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function fmt(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function escape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").replace(/\s+/g, " ").slice(0, 200);
}

main();
