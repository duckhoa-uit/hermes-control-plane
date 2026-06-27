#!/usr/bin/env bun
// Alert-rules sanity checker.
//
// `infra/observability/alerts.yaml` declares the alerts that should page
// the on-call. Each rule MUST point at a runbook anchor in
// `docs/OBSERVABILITY.md` so the responder has somewhere to start.
// This script reconciles the two files.
//
// Checks:
//   1. alerts.yaml parses, has `version: 1` and a `rules:` array.
//   2. Every rule has the required fields: name, summary, severity,
//      channels, runbook.
//   3. Rule names are unique.
//   4. Every `runbook:` anchor exists as a heading in OBSERVABILITY.md.
//      Anchors are GitHub-flavoured: lowercased, non-alphanum→`-`.
//   5. Severities are one of info/warning/critical.
//
// Run:  bun run alerts:check
//
// Exit codes: 0 clean / 1 findings / 2 internal error.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = process.cwd();
const ALERTS = join(REPO_ROOT, "infra/observability/alerts.yaml");
const RUNBOOK = join(REPO_ROOT, "docs/OBSERVABILITY.md");

const REQUIRED_FIELDS = ["name", "summary", "severity", "channels", "runbook"] as const;
const VALID_SEVERITIES = new Set(["info", "warning", "critical"]);

function anchorize(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function extractHeadingAnchors(md: string): Set<string> {
  const out = new Set<string>();
  for (const line of md.split("\n")) {
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (m) out.add(anchorize(m[1]));
  }
  return out;
}

function main(): void {
  if (!existsSync(ALERTS)) {
    console.error(`✗ ${ALERTS} not found`);
    process.exit(2);
  }
  if (!existsSync(RUNBOOK)) {
    console.error(`✗ ${RUNBOOK} not found`);
    process.exit(2);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(ALERTS, "utf8"));
  } catch (e) {
    console.error(`✗ alerts.yaml failed to parse:`, e);
    process.exit(2);
  }
  if (!parsed || typeof parsed !== "object") {
    console.error("✗ alerts.yaml root must be an object");
    process.exit(2);
  }
  const spec = parsed as Record<string, unknown>;
  if (spec.version !== 1) {
    console.error(`✗ alerts.yaml: expected version: 1, got ${JSON.stringify(spec.version)}`);
    process.exit(2);
  }
  const rules = spec.rules;
  if (!Array.isArray(rules)) {
    console.error("✗ alerts.yaml: rules must be an array");
    process.exit(2);
  }

  const anchors = extractHeadingAnchors(readFileSync(RUNBOOK, "utf8"));
  const findings: string[] = [];
  const seenNames = new Set<string>();

  for (const r of rules) {
    if (!r || typeof r !== "object") {
      findings.push("rule entry is not an object");
      continue;
    }
    const rule = r as Record<string, unknown>;
    const name = typeof rule.name === "string" ? rule.name : "<unnamed>";

    for (const field of REQUIRED_FIELDS) {
      if (!(field in rule) || rule[field] === undefined) {
        findings.push(`[${name}] missing required field "${field}"`);
      }
    }
    if (seenNames.has(name)) findings.push(`[${name}] duplicate rule name`);
    seenNames.add(name);

    const sev = rule.severity;
    if (typeof sev === "string" && !VALID_SEVERITIES.has(sev)) {
      findings.push(`[${name}] invalid severity "${sev}" (must be info|warning|critical)`);
    }

    const channels = rule.channels;
    if (!Array.isArray(channels) || channels.length === 0) {
      findings.push(`[${name}] channels must be a non-empty array`);
    }

    const runbook = rule.runbook;
    if (typeof runbook === "string") {
      const anchor = runbook.startsWith("#") ? runbook.slice(1) : runbook;
      if (!anchors.has(anchor)) {
        findings.push(
          `[${name}] runbook anchor "${runbook}" does not match any heading in docs/OBSERVABILITY.md`,
        );
      }
    }
  }

  if (findings.length === 0) {
    console.log(`✓ alerts.yaml: ${rules.length} rule(s), all runbook anchors resolve.`);
    process.exit(0);
  }
  console.log(`✗ ${findings.length} finding(s):`);
  for (const f of findings) console.log(`  - ${f}`);
  process.exit(1);
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  main();
}
