#!/usr/bin/env bun
// Lightweight OpenAPI sanity-checker.
//
// Goal: catch the kinds of regressions that turn `docs/openapi.yaml`
// into a lie, without pulling in a 30 MB validator dependency.
//
// What this checks:
//   1. The file exists and parses as YAML (via Bun's built-in `yaml`).
//   2. Top-level `openapi`, `info`, and `paths` keys are present.
//   3. Every path's HTTP-method operation has a `responses` map with at
//      least one `2xx` or `default` entry.
//   4. Every operation references existing components when it $refs one
//      (catches typos like `#/components/schemas/SesionState`).
//
// What this deliberately does NOT do:
//   - Full OpenAPI 3.1 schema validation (delegated to editor tooling
//     like Stoplight Spectral or the Swagger UI preview); they require
//     installing a heavier dependency and we keep the local CI fast.
//
// Run:  bun run openapi:check
//
// Exit codes:
//   0 — clean
//   1 — one or more findings
//   2 — internal error (file missing / unparseable)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = process.cwd();
const SPEC = join(REPO_ROOT, "docs", "openapi.yaml");

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

interface Finding {
  where: string;
  msg: string;
}

function collectRefs(value: unknown, out: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === "$ref" && typeof v === "string") out.push(v);
    else collectRefs(v, out);
  }
}

function resolveRef(spec: Record<string, unknown>, ref: string): boolean {
  // Only resolve internal refs (`#/components/schemas/...`); external
  // refs are out of scope for this checker.
  if (!ref.startsWith("#/")) return true;
  const parts = ref.slice(2).split("/");
  let cur: unknown = spec;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return false;
    cur = (cur as Record<string, unknown>)[p];
    if (cur === undefined) return false;
  }
  return true;
}

function main(): void {
  if (!existsSync(SPEC)) {
    console.error(`✗ ${SPEC} not found`);
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(SPEC, "utf8"));
  } catch (e) {
    console.error(`✗ ${SPEC} failed to parse:`, e);
    process.exit(2);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("✗ openapi.yaml root must be an object");
    process.exit(2);
  }
  const spec = parsed as Record<string, unknown>;
  const findings: Finding[] = [];

  for (const key of ["openapi", "info", "paths"]) {
    if (!(key in spec)) findings.push({ where: "root", msg: `missing top-level "${key}"` });
  }

  const paths = (spec.paths ?? {}) as Record<string, unknown>;
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") {
      findings.push({ where: pathKey, msg: "path item is not an object" });
      continue;
    }
    for (const [methodKey, op] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(methodKey.toLowerCase())) continue;
      if (!op || typeof op !== "object") {
        findings.push({ where: `${pathKey} ${methodKey}`, msg: "operation is not an object" });
        continue;
      }
      const responses = (op as Record<string, unknown>).responses;
      if (!responses || typeof responses !== "object") {
        findings.push({
          where: `${pathKey} ${methodKey}`,
          msg: "operation has no `responses` map",
        });
        continue;
      }
      const codes = Object.keys(responses as Record<string, unknown>);
      const hasSuccess = codes.some(
        (c) => c === "default" || (c.length === 3 && (c.startsWith("2") || c.startsWith("3"))),
      );
      if (!hasSuccess) {
        findings.push({
          where: `${pathKey} ${methodKey}`,
          msg: `responses must include at least one 2xx/3xx or "default" entry (got ${codes.join(",")})`,
        });
      }
    }
  }

  // $ref reachability.
  const refs: string[] = [];
  collectRefs(spec, refs);
  for (const ref of refs) {
    if (!resolveRef(spec, ref)) {
      findings.push({ where: "$ref", msg: `unresolved reference: ${ref}` });
    }
  }

  if (findings.length === 0) {
    console.log("✓ openapi.yaml: structure ok, all responses present, all $refs resolve.");
    process.exit(0);
  }
  console.log(`✗ ${findings.length} finding(s):`);
  for (const f of findings) console.log(`  - [${f.where}] ${f.msg}`);
  process.exit(1);
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  main();
}
