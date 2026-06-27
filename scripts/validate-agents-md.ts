#!/usr/bin/env bun
// AGENTS.md freshness validator.
//
// AGENTS.md tells an agent which `bun run <script>` commands to run. If
// those commands rot (renamed, deleted, replaced), the agent follows
// stale instructions and either errors out cryptically or — worse —
// runs a different command silently. This script catches the rot
// early.
//
// What it checks (each as a separate, non-blocking-until-final pass so
// the operator sees every problem in one run):
//
//   1. Every `bun run <name>` referenced in AGENTS.md exists in
//      `package.json`'s "scripts" map.
//   2. Every linked file (e.g. `docs/ARCHITECTURE.md`,
//      `feature-flags.json`, `src/core/state-machine.ts`) exists at
//      the referenced path.
//   3. AGENTS.md is non-trivial (>2 KB, >50 lines) — a guard against
//      accidental truncation by an agent.
//   4. README.md links to AGENTS.md, so agents that read the README
//      first find it.
//
// Exit codes:
//   0  clean
//   1  one or more findings (CI gate)
//   2  internal error (AGENTS.md missing, malformed package.json, …)
//
// Run:  bun run agents:check        (alias in package.json)
//       bun run scripts/validate-agents-md.ts --json   (machine-readable)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const REPO_ROOT = process.cwd();
const AGENTS_MD = join(REPO_ROOT, "AGENTS.md");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");
const README_MD = join(REPO_ROOT, "README.md");

const MIN_BYTES = 2048;
const MIN_LINES = 50;

// `bun run <script>` mentioned anywhere — backticked or naked. We
// deliberately do NOT match `bunx wrangler dev` etc. since those
// aren't package.json scripts.
const SCRIPT_RE = /\bbun\s+run\s+([a-zA-Z][a-zA-Z0-9:_-]*)/g;

// Markdown link to a path that looks like a repo-local file (not http,
// not anchor-only). Two flavours: `[label](path)` and bare backticked
// `path/with/slashes`. We only follow the link form; backticked paths
// are too noisy.
const LINK_RE = /\[[^\]]+\]\(([^)]+)\)/g;

interface Report {
  missingScripts: { name: string; lineHint: number }[];
  missingLinks: { path: string; lineHint: number }[];
  trivialSize: { bytes: number; lines: number } | null;
  readmeMissingLink: boolean;
}

// ---------------------------------------------------------------------------

export function extractScriptMentions(md: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    SCRIPT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SCRIPT_RE.exec(lines[i])) !== null) {
      // Only record the first line a script is referenced from.
      if (!out.has(m[1])) out.set(m[1], i + 1);
    }
  }
  return out;
}

export function extractMarkdownLinks(md: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(lines[i])) !== null) {
      const target = m[1].trim();
      // Skip:
      //   - URLs (http, https, mailto)
      //   - anchor-only links (#section)
      //   - inline data-uris
      //   - schemes we don't resolve
      if (
        target.startsWith("http://") ||
        target.startsWith("https://") ||
        target.startsWith("mailto:") ||
        target.startsWith("#") ||
        target.startsWith("data:")
      ) {
        continue;
      }
      // Strip an anchor from a path link (`docs/foo.md#bar` → `docs/foo.md`).
      const cleaned = target.split("#")[0];
      if (!cleaned) continue;
      if (!out.has(cleaned)) out.set(cleaned, i + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

interface PackageJson {
  scripts?: Record<string, string>;
}

function loadPackageJson(): PackageJson {
  let raw: string;
  try {
    raw = readFileSync(PACKAGE_JSON, "utf8");
  } catch {
    console.error("✗ package.json not found");
    process.exit(2);
  }
  try {
    return JSON.parse(raw) as PackageJson;
  } catch (e) {
    console.error("✗ package.json is not valid JSON:", e);
    process.exit(2);
  }
}

function loadAgentsMd(): string {
  if (!existsSync(AGENTS_MD)) {
    console.error("✗ AGENTS.md not found at repo root");
    process.exit(2);
  }
  return readFileSync(AGENTS_MD, "utf8");
}

function reconcile(md: string, pkg: PackageJson, readmeText: string | null): Report {
  const scripts = pkg.scripts ?? {};
  const referencedScripts = extractScriptMentions(md);
  const referencedLinks = extractMarkdownLinks(md);

  const missingScripts: Report["missingScripts"] = [];
  for (const [name, line] of referencedScripts) {
    if (!(name in scripts)) {
      missingScripts.push({ name, lineHint: line });
    }
  }

  // Resolve link targets relative to AGENTS.md's directory (i.e. repo
  // root). If the file doesn't exist, that's a stale link.
  const missingLinks: Report["missingLinks"] = [];
  for (const [path, line] of referencedLinks) {
    const resolved = join(dirname(AGENTS_MD), path);
    if (!existsSync(resolved)) {
      missingLinks.push({ path, lineHint: line });
    }
  }

  const bytes = Buffer.byteLength(md, "utf8");
  const lines = md.split("\n").length;
  const trivialSize = bytes < MIN_BYTES || lines < MIN_LINES ? { bytes, lines } : null;

  // README must link to AGENTS.md (so agents that land in README first
  // find it). Permissive match — any occurrence of `AGENTS.md` is fine.
  const readmeMissingLink = readmeText !== null && !readmeText.includes("AGENTS.md");

  return { missingScripts, missingLinks, trivialSize, readmeMissingLink };
}

// ---------------------------------------------------------------------------

function printHuman(report: Report): void {
  let findings = 0;

  if (report.trivialSize) {
    findings++;
    console.log(
      `✗ AGENTS.md looks trivial: ${report.trivialSize.bytes} B / ${report.trivialSize.lines} lines (min ${MIN_BYTES} B / ${MIN_LINES} lines).`,
    );
    console.log("  Did it get truncated? Restore the full file.");
  }

  if (report.missingScripts.length > 0) {
    findings += report.missingScripts.length;
    console.log(
      `\n✗ ${report.missingScripts.length} missing npm script(s) referenced in AGENTS.md:`,
    );
    for (const m of report.missingScripts) {
      console.log(`    - bun run ${m.name}   (AGENTS.md:${m.lineHint})`);
    }
    console.log(
      "  Either add the script to package.json or update AGENTS.md to use the current command name.",
    );
  }

  if (report.missingLinks.length > 0) {
    findings += report.missingLinks.length;
    console.log(`\n✗ ${report.missingLinks.length} broken file link(s) in AGENTS.md:`);
    for (const m of report.missingLinks) {
      console.log(`    - ${m.path}   (AGENTS.md:${m.lineHint})`);
    }
    console.log(
      "  Either restore the file at that path or update AGENTS.md to point at the new location.",
    );
  }

  if (report.readmeMissingLink) {
    findings++;
    console.log("\n✗ README.md does not mention AGENTS.md.");
    console.log("  Add a link so agents that land in README first find AGENTS.md.");
  }

  if (findings === 0) {
    console.log(
      "✓ AGENTS.md is fresh: all referenced scripts exist, all links resolve, README points at it.",
    );
  } else {
    console.log(`\n✗ ${findings} finding(s). See above.`);
  }
}

function writeStepSummary(report: Report): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const lines: string[] = [];
  lines.push("## AGENTS.md freshness audit");
  lines.push("");
  lines.push("| Check | Count |");
  lines.push("|---|---:|");
  lines.push(`| Missing scripts | ${report.missingScripts.length} |`);
  lines.push(`| Broken file links | ${report.missingLinks.length} |`);
  lines.push(`| Trivial size | ${report.trivialSize ? "yes" : "no"} |`);
  lines.push(`| README link to AGENTS.md | ${report.readmeMissingLink ? "missing" : "ok"} |`);
  lines.push("");
  if (report.missingScripts.length > 0) {
    lines.push("### Missing scripts");
    for (const m of report.missingScripts) {
      lines.push(`- \`bun run ${m.name}\` (AGENTS.md:${m.lineHint})`);
    }
    lines.push("");
  }
  if (report.missingLinks.length > 0) {
    lines.push("### Broken file links");
    for (const m of report.missingLinks) {
      lines.push(`- \`${m.path}\` (AGENTS.md:${m.lineHint})`);
    }
    lines.push("");
  }
  writeFileSync(path, lines.join("\n") + "\n", { flag: "a" });
}

// ---------------------------------------------------------------------------

function main(): void {
  const args = new Set(process.argv.slice(2));
  const md = loadAgentsMd();
  const pkg = loadPackageJson();
  const readmeText = existsSync(README_MD) ? readFileSync(README_MD, "utf8") : null;

  const report = reconcile(md, pkg, readmeText);

  if (args.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  writeStepSummary(report);

  const findings =
    report.missingScripts.length +
    report.missingLinks.length +
    (report.trivialSize ? 1 : 0) +
    (report.readmeMissingLink ? 1 : 0);
  process.exit(findings === 0 ? 0 : 1);
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  main();
}
