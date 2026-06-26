#!/usr/bin/env bun
// Dead-feature-flag detector.
//
// Reconciles the flag registry in `feature-flags.json` with the call sites in
// `src/**.ts`. Reports three failure modes:
//
//   1. Declared-but-unused — a flag is registered but no call site refers
//      to it. The branch behind the flag is dead; delete the entry + the
//      `if (isFlagEnabled(...))` body (whichever leg is the obsolete one).
//
//   2. Used-but-undeclared — a call site mentions a flag name that isn't
//      registered. The author forgot to update the registry; CI fails
//      until they add an entry.
//
//   3. Stale — a registered flag is older than `maxAgeDays` (default 90).
//      Forces a periodic decision: ship the change, or extend the window
//      with a deliberate `maxAgeDays` bump and a justification.
//
// Exit codes:
//   0  clean
//   1  one or more findings (CI gate)
//   2  internal error (bad JSON, no registry, etc.)
//
// Run:  bun run flags:check         (alias in package.json)
//       bun run scripts/detect-dead-flags.ts --json   (machine-readable)

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Config

const REPO_ROOT = process.cwd();
const REGISTRY_PATH = join(REPO_ROOT, "feature-flags.json");
const SCAN_DIRS = ["src", "scripts", "infra"];
const SCAN_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
// Files we never recurse into.
const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", ".git", "tests"]);

// Default staleness window. A flag older than this is reported even if it
// still has a live call site — agents and humans should periodically decide
// "ship it" vs "remove it".
const DEFAULT_MAX_AGE_DAYS = 90;

// Call-site signature. Matches the three public entry points of
// src/core/feature-flags.ts.
const CALL_SITE_RE =
  /\b(?:isFlagEnabled|percentageRollout|flagValue)\s*\(\s*["'`]([a-z][a-z0-9_]*)["'`]/g;

// ---------------------------------------------------------------------------
// Types

export interface RegistryFlag {
  name: string;
  kind: "boolean" | "rollout" | "variant";
  owner: string;
  createdAt: string; // YYYY-MM-DD
  maxAgeDays?: number;
  cleanup?: string;
  description?: string;
}

export interface CallSite {
  flag: string;
  file: string;
  line: number;
}

export interface Report {
  declaredButUnused: { name: string; owner: string; createdAt: string }[];
  usedButUndeclared: { name: string; sites: CallSite[] }[];
  stale: { name: string; ageDays: number; maxAgeDays: number; owner: string }[];
}

// ---------------------------------------------------------------------------
// Filesystem walk

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // SCAN_DIRS might not all exist
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      walk(p, out);
    } else if (SCAN_EXTS.has(extOf(name))) {
      out.push(p);
    }
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i) : "";
}

// ---------------------------------------------------------------------------
// Call-site extraction

function findCallSites(files: string[]): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of files) {
    // Skip the feature-flags module itself — its source contains the
    // signatures of the functions, not real call sites.
    if (file.endsWith("src/core/feature-flags.ts")) continue;
    const content = readFileSync(file, "utf8");
    // Walk line-by-line so we can attach a line number cheaply.
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Fast bail-out — the regex below is O(n) on the whole line.
      if (
        !line.includes("isFlagEnabled(") &&
        !line.includes("percentageRollout(") &&
        !line.includes("flagValue(")
      ) {
        continue;
      }
      // Reset the regex state because we reuse it across lines.
      CALL_SITE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_SITE_RE.exec(line)) !== null) {
        sites.push({ flag: m[1], file: relative(REPO_ROOT, file), line: i + 1 });
      }
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Registry parsing

function loadRegistry(): RegistryFlag[] {
  let raw: string;
  try {
    raw = readFileSync(REGISTRY_PATH, "utf8");
  } catch {
    console.error(`✗ ${relative(REPO_ROOT, REGISTRY_PATH)} not found.`);
    console.error('  Create it with `{ "flags": [] }` if you have no flags yet.');
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`✗ ${relative(REPO_ROOT, REGISTRY_PATH)} is not valid JSON:`, e);
    process.exit(2);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { flags?: unknown }).flags)
  ) {
    console.error(`✗ ${relative(REPO_ROOT, REGISTRY_PATH)} must have a top-level "flags" array.`);
    process.exit(2);
  }
  const flags = (parsed as { flags: RegistryFlag[] }).flags;
  const seen = new Set<string>();
  for (const f of flags) {
    if (!f.name || !/^[a-z][a-z0-9_]*$/.test(f.name)) {
      console.error(
        `✗ Invalid flag name: ${JSON.stringify(f.name)} (must be lowercase snake_case).`,
      );
      process.exit(2);
    }
    if (seen.has(f.name)) {
      console.error(`✗ Duplicate flag entry for "${f.name}".`);
      process.exit(2);
    }
    seen.add(f.name);
    if (!f.kind || !["boolean", "rollout", "variant"].includes(f.kind)) {
      console.error(`✗ Flag "${f.name}" has invalid kind "${f.kind}".`);
      process.exit(2);
    }
    if (!f.owner) {
      console.error(`✗ Flag "${f.name}" is missing required "owner".`);
      process.exit(2);
    }
    if (!f.createdAt || Number.isNaN(Date.parse(f.createdAt))) {
      console.error(`✗ Flag "${f.name}" has invalid createdAt "${f.createdAt}".`);
      process.exit(2);
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Reconciliation

export function reconcile(
  flags: RegistryFlag[],
  sites: CallSite[],
  opts: { now?: number; defaultMaxAgeDays?: number } = {},
): Report {
  const nowMs = opts.now ?? Date.now();
  const defaultMax = opts.defaultMaxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const usedFlags = new Map<string, CallSite[]>();
  for (const s of sites) {
    const arr = usedFlags.get(s.flag) ?? [];
    arr.push(s);
    usedFlags.set(s.flag, arr);
  }

  const declared = new Set(flags.map((f) => f.name));

  const declaredButUnused = flags
    .filter((f) => !usedFlags.has(f.name))
    .map((f) => ({ name: f.name, owner: f.owner, createdAt: f.createdAt }));

  const usedButUndeclared = [...usedFlags.entries()]
    .filter(([name]) => !declared.has(name))
    .map(([name, callSites]) => ({ name, sites: callSites }));

  const stale: Report["stale"] = [];
  for (const f of flags) {
    if (!usedFlags.has(f.name)) continue; // already flagged as unused
    const ageDays = Math.floor((nowMs - Date.parse(f.createdAt)) / (1000 * 60 * 60 * 24));
    const max = f.maxAgeDays ?? defaultMax;
    if (ageDays > max) {
      stale.push({ name: f.name, ageDays, maxAgeDays: max, owner: f.owner });
    }
  }

  return { declaredButUnused, usedButUndeclared, stale };
}

// ---------------------------------------------------------------------------
// Output

function plural(n: number, s: string, p?: string): string {
  return `${n} ${n === 1 ? s : (p ?? s + "s")}`;
}

function printHuman(report: Report, totals: { flags: number; sites: number }): void {
  console.log(
    `Feature flags: scanned ${totals.flags} registered flag(s), ${totals.sites} call site(s).`,
  );

  if (report.declaredButUnused.length > 0) {
    console.log(
      `\n✗ ${plural(report.declaredButUnused.length, "dead flag")} (declared, no call site):`,
    );
    for (const d of report.declaredButUnused) {
      console.log(`    - ${d.name}   owner=${d.owner}   added=${d.createdAt}`);
    }
    console.log("  Remove the entry from feature-flags.json and delete the obsolete branch.");
  }

  if (report.usedButUndeclared.length > 0) {
    console.log(
      `\n✗ ${plural(report.usedButUndeclared.length, "undeclared flag")} (used, not registered):`,
    );
    for (const u of report.usedButUndeclared) {
      for (const s of u.sites.slice(0, 3)) {
        console.log(`    - ${u.name}   ${s.file}:${s.line}`);
      }
      if (u.sites.length > 3) {
        console.log(`      (+${u.sites.length - 3} more call site(s))`);
      }
    }
    console.log("  Add an entry to feature-flags.json with owner + createdAt.");
  }

  if (report.stale.length > 0) {
    console.log(
      `\n✗ ${plural(report.stale.length, "stale flag")} (older than the configured window):`,
    );
    for (const s of report.stale) {
      console.log(`    - ${s.name}   age=${s.ageDays}d   max=${s.maxAgeDays}d   owner=${s.owner}`);
    }
    console.log(
      "  Decide: ship the change and delete the flag, or bump `maxAgeDays` with a written reason.",
    );
  }

  const findings =
    report.declaredButUnused.length + report.usedButUndeclared.length + report.stale.length;
  if (findings === 0) {
    console.log("\n✓ no dead, undeclared, or stale feature flags.");
  } else {
    console.log(`\n✗ ${plural(findings, "finding")}. See above.`);
  }
}

function writeStepSummary(report: Report, totals: { flags: number; sites: number }): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const lines: string[] = [];
  lines.push("## Feature flag audit");
  lines.push("");
  lines.push(`Registered flags: **${totals.flags}**   Call sites: **${totals.sites}**`);
  lines.push("");
  const sections: [string, number][] = [
    ["Dead (declared, no call site)", report.declaredButUnused.length],
    ["Undeclared (used, not registered)", report.usedButUndeclared.length],
    ["Stale (older than configured window)", report.stale.length],
  ];
  lines.push("| Category | Count |");
  lines.push("|---|---:|");
  for (const [label, n] of sections) {
    lines.push(`| ${label} | ${n} |`);
  }
  lines.push("");
  if (report.declaredButUnused.length > 0) {
    lines.push("### Dead flags");
    for (const d of report.declaredButUnused) {
      lines.push(`- \`${d.name}\` (owner ${d.owner}, added ${d.createdAt})`);
    }
    lines.push("");
  }
  if (report.usedButUndeclared.length > 0) {
    lines.push("### Undeclared flags");
    for (const u of report.usedButUndeclared) {
      lines.push(`- \`${u.name}\` — ${u.sites.length} call site(s)`);
    }
    lines.push("");
  }
  if (report.stale.length > 0) {
    lines.push("### Stale flags");
    for (const s of report.stale) {
      lines.push(`- \`${s.name}\` — age ${s.ageDays}d / max ${s.maxAgeDays}d (owner ${s.owner})`);
    }
    lines.push("");
  }
  writeFileSync(path, lines.join("\n") + "\n", { flag: "a" });
}

// ---------------------------------------------------------------------------
// Extract call sites from raw source text. Exported for tests; the file
// walker calls this once per source file.

export function extractCallSitesFromText(file: string, content: string): CallSite[] {
  const sites: CallSite[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      !line.includes("isFlagEnabled(") &&
      !line.includes("percentageRollout(") &&
      !line.includes("flagValue(")
    ) {
      continue;
    }
    CALL_SITE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_SITE_RE.exec(line)) !== null) {
      sites.push({ flag: m[1], file, line: i + 1 });
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Main

function main(): void {
  const args = new Set(process.argv.slice(2));
  const flags = loadRegistry();

  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(join(REPO_ROOT, d), files);
  const sites = findCallSites(files);

  const report = reconcile(flags, sites);
  const totals = { flags: flags.length, sites: sites.length };

  if (args.has("--json")) {
    console.log(JSON.stringify({ totals, report }, null, 2));
  } else {
    printHuman(report, totals);
  }
  writeStepSummary(report, totals);

  const findings =
    report.declaredButUnused.length + report.usedButUndeclared.length + report.stale.length;
  process.exit(findings === 0 ? 0 : 1);
}

// Run main() only when executed directly (not when imported by a test).
// Bun sets `import.meta.main = true` for the entry file.
if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  main();
}
