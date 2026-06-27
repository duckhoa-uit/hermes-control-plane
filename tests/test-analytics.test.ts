// Test analytics summarizer — unit tests.
//
// The summarizer runs as a non-blocking CI step (the workflow's
// `Test analytics summary` step) and feeds `$GITHUB_STEP_SUMMARY`. A
// silent parsing regression there is hard to spot from the run page,
// so we cover the parser shape with three explicit fixtures: clean
// run, flaky run, failed run.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(__dirname, "..", "scripts", "test-analytics.ts");

function runScript(xmlPath: string): { stdout: string; status: number } {
  const result = spawnSync("bun", ["run", SCRIPT, xmlPath], {
    encoding: "utf8",
  });
  return { stdout: result.stdout, status: result.status ?? 1 };
}

describe("scripts/test-analytics.ts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "analytics-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a clean run with total counts and no warning sections", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest" tests="3" failures="0" skipped="0" time="0.500">
  <testsuite name="tests/a.test.ts" tests="2" failures="0" time="0.200">
    <testcase classname="tests/a.test.ts" name="adds numbers" time="0.05"/>
    <testcase classname="tests/a.test.ts" name="subtracts numbers" time="0.10"/>
  </testsuite>
  <testsuite name="tests/b.test.ts" tests="1" failures="0" time="0.300">
    <testcase classname="tests/b.test.ts" name="reads disk" time="0.30"/>
  </testsuite>
</testsuites>`;
    const path = join(dir, "ok.xml");
    writeFileSync(path, xml);
    const { stdout, status } = runScript(path);
    expect(status).toBe(0);
    expect(stdout).toContain("**3** tests across **2** files");
    expect(stdout).toContain("passed: 3");
    expect(stdout).not.toContain("Flaky tests");
    expect(stdout).not.toContain("Failed tests");
  });

  it("highlights flaky tests with a rerunFailure block", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest" tests="1" failures="0" skipped="0" time="0.400">
  <testsuite name="tests/flaky.test.ts" tests="1" failures="0" time="0.400">
    <testcase classname="tests/flaky.test.ts" name="races a timer" time="0.40">
      <rerunFailure message="timed out" type="AssertionError"/>
    </testcase>
  </testsuite>
</testsuites>`;
    const path = join(dir, "flaky.xml");
    writeFileSync(path, xml);
    const { stdout, status } = runScript(path);
    expect(status).toBe(0);
    expect(stdout).toContain("Flaky tests");
    expect(stdout).toContain("flaky: 1");
    expect(stdout).toContain("races a timer");
    expect(stdout).toContain("Slow tests");
  });

  it("renders a failed-tests table with the failure message", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest" tests="2" failures="1" skipped="0" time="0.250">
  <testsuite name="tests/bad.test.ts" tests="2" failures="1" time="0.250">
    <testcase classname="tests/bad.test.ts" name="passes ok" time="0.05"/>
    <testcase classname="tests/bad.test.ts" name="fails hard" time="0.10">
      <failure message="expected 1 to equal 2" type="AssertionError">stack…</failure>
    </testcase>
  </testsuite>
</testsuites>`;
    const path = join(dir, "fail.xml");
    writeFileSync(path, xml);
    const { stdout, status } = runScript(path);
    expect(status).toBe(0);
    expect(stdout).toContain("Failed tests");
    expect(stdout).toContain("fails hard");
    expect(stdout).toContain("expected 1 to equal 2");
  });

  it("exits 0 with a friendly message when the report is missing", () => {
    const { stdout, status } = runScript(join(dir, "does-not-exist.xml"));
    expect(status).toBe(0);
    expect(stdout).toContain("No junit report found");
  });
});
