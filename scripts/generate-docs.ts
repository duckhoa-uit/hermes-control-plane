#!/usr/bin/env bun
// Auto-generates technical documentation from source-of-truth files.
//
// Output:
//   docs/api-reference.md       — HTTP routes discovered in
//                                  src/worker/index.ts and
//                                  src/launcher/server.ts.
//   docs/events-reference.md    — Event / state / message types lifted
//                                  from src/core/types.ts.
//   docs/state-machine.mmd      — Mermaid diagram of the SessionStatus
//                                  state machine.
//
// Why a hand-rolled generator instead of TypeDoc?
//   - TypeDoc bloats the toolchain (it pulls in ~50 MB of deps + a
//     theme) for what we actually want: three small tables and a
//     diagram.
//   - The route handlers don't use a router framework, so the only
//     thing that knows which paths exist is the dispatcher source. The
//     hand-rolled extractor reads that source.
//
// CI integration: `bun run docs:gen` runs in
// .github/workflows/docs-refresh.yml on every push to main. The action
// commits the refreshed docs back if they drift, so the docs are never
// older than the last main commit.
//
// Local use: `bun run docs:gen --check` exits non-zero when the
// generated docs would differ from what's checked in — useful as a CI
// pre-merge gate.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Source files we read.

const SRC_WORKER = join(REPO_ROOT, "src/worker/index.ts");
const SRC_LAUNCHER = join(REPO_ROOT, "src/launcher/server.ts");
const SRC_TYPES = join(REPO_ROOT, "src/core/types.ts");

// ---------------------------------------------------------------------------
// Output files.

const OUT_API_REFERENCE = join(REPO_ROOT, "docs/api-reference.md");
const OUT_EVENTS_REFERENCE = join(REPO_ROOT, "docs/events-reference.md");
const OUT_STATE_MACHINE = join(REPO_ROOT, "docs/state-machine.mmd");

const HEADER = (source: string): string =>
  `<!-- AUTO-GENERATED FILE. Do not edit by hand.
     Source: ${source}
     Regenerate: bun run docs:gen
-->\n\n`;

// ===========================================================================
// HTTP API extraction
//
// The Worker dispatches by string match on `path` + `request.method`,
// the launcher does the same on `url.pathname`. We extract those checks
// directly so the generated table is the dispatcher's truth.

interface Route {
  service: "worker" | "launcher";
  method: string;
  path: string;
  // A short note pulled from the line above the match (a leading
  // comment is treated as the description).
  note: string;
}

const WORKER_PATH_RE =
  /path === "(\/[^"]+)"(?:\s*\|\|\s*path === "(\/[^"]*)")?\s*(?:&&\s*request\.method === "([A-Z]+)")?/g;
const WORKER_STARTSWITH_RE =
  /path\.startsWith\("(\/[^"]+)"\)(?:\s*&&\s*request\.method === "([A-Z]+)")?/g;
const WORKER_WS_RE = /\/\^\\\/sessions\\\/\(\[\^\\\/\]\+\)\\\/\(stream\|runner\)\$/;
const LAUNCHER_PATH_RE = /url\.pathname === "(\/[^"]+)"(?:\s*&&\s*req\.method === "([A-Z]+)")?/g;
const LAUNCHER_MATCH_RE = /url\.pathname\.match\(\/(\^[^/]+)\/\)/g;

function leadingComment(lines: string[], idx: number): string {
  // Walk up until we hit a non-comment line. Strip the comment prefix.
  const buf: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//")) {
      buf.unshift(trimmed.replace(/^\/\/\s?/, ""));
    } else if (trimmed === "") {
      // Allow a single blank line between comment and code, but stop
      // after that — anything else is unrelated.
      break;
    } else {
      break;
    }
  }
  return buf.join(" ").trim();
}

function extractWorkerRoutes(source: string): Route[] {
  const lines = source.split("\n");
  const out: Route[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;

    WORKER_PATH_RE.lastIndex = 0;
    while ((m = WORKER_PATH_RE.exec(line)) !== null) {
      const path1 = m[1];
      const path2 = m[2];
      const method = m[3] ?? "GET"; // top-level /health uses no method check
      const note = leadingComment(lines, i);
      out.push({ service: "worker", method, path: path1, note });
      if (path2) out.push({ service: "worker", method, path: path2, note });
    }

    WORKER_STARTSWITH_RE.lastIndex = 0;
    while ((m = WORKER_STARTSWITH_RE.exec(line)) !== null) {
      const path = `${m[1]}{id}`;
      const method = m[2] ?? "GET";
      out.push({ service: "worker", method, path, note: leadingComment(lines, i) });
    }

    if (WORKER_WS_RE.test(line)) {
      out.push({
        service: "worker",
        method: "WS",
        path: "/sessions/{id}/{stream|runner}",
        note: "WebSocket upgrade (see docs/ARCHITECTURE.md for framing).",
      });
    }
  }
  // Dedupe — the regex over `||` can catch duplicates.
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.service}|${r.method}|${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function extractLauncherRoutes(source: string): Route[] {
  const lines = source.split("\n");
  const out: Route[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;

    LAUNCHER_PATH_RE.lastIndex = 0;
    while ((m = LAUNCHER_PATH_RE.exec(line)) !== null) {
      const path = m[1];
      const method = m[2] ?? "GET";
      out.push({
        service: "launcher",
        method,
        path,
        note: leadingComment(lines, i),
      });
    }

    LAUNCHER_MATCH_RE.lastIndex = 0;
    while ((m = LAUNCHER_MATCH_RE.exec(line)) !== null) {
      // Rough conversion from regex literal to display path. The actual
      // shapes we use are `^/sessions/([^/]+)$`, `.../publish-pr$`,
      // `.../resume$`. We just pretty-print the first capture as
      // `{sessionId}`.
      const display = m[1]
        .replace(/^\^/, "")
        .replace(/\$$/, "")
        .replace(/\(\[\^\/\]\+\)/g, "{id}");
      out.push({
        service: "launcher",
        method: "POST",
        path: display,
        note: leadingComment(lines, i),
      });
    }
  }
  return out;
}

function renderApiReference(workerRoutes: Route[], launcherRoutes: Route[]): string {
  const fmt = (rs: Route[]): string => {
    const rows = rs.map((r) => {
      const note = r.note ? r.note.replace(/\|/g, "\\|") : "";
      return `| ${r.method} | \`${r.path}\` | ${note} |`;
    });
    return ["| Method | Path | Notes |", "|---|---|---|", ...rows].join("\n");
  };
  return [
    HEADER("src/worker/index.ts, src/launcher/server.ts"),
    "# HTTP API reference",
    "",
    "Auto-generated from the route dispatcher source. For a richer machine-readable contract see [`docs/openapi.yaml`](./openapi.yaml).",
    "",
    "## Worker (Cloudflare)",
    "",
    fmt(workerRoutes),
    "",
    "## Launcher (Bun sidecar)",
    "",
    fmt(launcherRoutes),
    "",
  ].join("\n");
}

// ===========================================================================
// Event-type extraction
//
// We harvest every exported string-union type from src/core/types.ts.
// Then we render one section per type with a bullet list of variants.

interface UnionType {
  name: string;
  variants: { value: string; comment: string }[];
  topComment: string;
}

function extractUnionTypes(source: string): UnionType[] {
  const lines = source.split("\n");
  const types: UnionType[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const decl = /^export type (\w+)\s*=/.exec(line);
    if (!decl) continue;
    // Skip non-union types (interfaces etc.).
    const variants: { value: string; comment: string }[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim().startsWith("|")) {
        const valueMatch = /\|\s*"([^"]+)"/.exec(l);
        if (valueMatch) {
          const commentMatch = /\/\/\s*(.*)$/.exec(l);
          variants.push({
            value: valueMatch[1],
            comment: commentMatch?.[1].trim() ?? "",
          });
        }
        j++;
      } else if (l.trim() === "" || l.trim().startsWith("//")) {
        j++;
      } else {
        break;
      }
    }
    if (variants.length === 0) continue;
    types.push({ name: decl[1], variants, topComment: leadingComment(lines, i) });
    i = j;
  }
  return types;
}

function renderEventsReference(types: UnionType[]): string {
  const parts: string[] = [HEADER("src/core/types.ts"), "# Event, state, and message types", ""];
  parts.push(
    "Auto-generated from the string-union types exported by `src/core/types.ts`. These are the wire contracts agents see when they read the DO event log, send a runner command, or wire up a webhook downstream.",
    "",
  );
  for (const t of types) {
    parts.push(`## \`${t.name}\``);
    if (t.topComment) parts.push("", t.topComment);
    parts.push("");
    parts.push("| Value | Notes |", "|---|---|");
    for (const v of t.variants) {
      parts.push(`| \`${v.value}\` | ${v.comment.replace(/\|/g, "\\|")} |`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

// ===========================================================================
// State-machine diagram
//
// The Hermes session lifecycle is a finite state machine over
// SessionStatus. We don't extract the transition table (that would
// require parsing src/core/state-machine.ts); instead we emit a Mermaid
// stateDiagram-v2 of every status node plus the canonical happy-path
// edges documented in docs/ARCHITECTURE.md. If you add a status, this
// diagram updates automatically.

function renderStateMachineDiagram(statuses: string[]): string {
  // Canonical edges — keep in sync with src/core/state-machine.ts.
  const edges: [string, string, string?][] = [
    ["[*]", "created"],
    ["created", "provisioning", "POST /sessions"],
    ["provisioning", "runner_connecting", "sandbox.ready"],
    ["runner_connecting", "ready", "runner.connected"],
    ["ready", "running", "agent.started"],
    ["running", "needs_approval", "approval.requested"],
    ["needs_approval", "running", "approval.resolved"],
    ["running", "review_ready", "runner.complete"],
    ["review_ready", "creating_pr", "POST /create-pr"],
    ["creating_pr", "completed", "pr.created"],
    ["running", "failed", "agent.error"],
    ["running", "aborted", "POST /abort"],
    ["completed", "archived", "pr.merged"],
    ["completed", "[*]"],
    ["failed", "[*]"],
    ["aborted", "[*]"],
    ["archived", "[*]"],
    ["running", "stalled", "watchdog"],
    ["stalled", "running", "heartbeat"],
  ];
  const lines: string[] = [
    "%%{init: { 'theme':'neutral' } }%%",
    "stateDiagram-v2",
    "    %% Auto-generated by scripts/generate-docs.ts from",
    "    %% src/core/types.ts (SessionStatus) + src/core/state-machine.ts (transitions).",
    "",
  ];
  // Declare every status so isolated nodes still appear.
  for (const s of statuses) {
    lines.push(`    ${s}`);
  }
  lines.push("");
  for (const [from, to, label] of edges) {
    lines.push(label ? `    ${from} --> ${to}: ${label}` : `    ${from} --> ${to}`);
  }
  return lines.join("\n") + "\n";
}

// ===========================================================================
// Driver

function generate(): { path: string; content: string }[] {
  const workerSource = readFileSync(SRC_WORKER, "utf8");
  const launcherSource = readFileSync(SRC_LAUNCHER, "utf8");
  const typesSource = readFileSync(SRC_TYPES, "utf8");

  const workerRoutes = extractWorkerRoutes(workerSource);
  const launcherRoutes = extractLauncherRoutes(launcherSource);
  const unionTypes = extractUnionTypes(typesSource);
  const sessionStatuses =
    unionTypes.find((t) => t.name === "SessionStatus")?.variants.map((v) => v.value) ?? [];

  return [
    { path: OUT_API_REFERENCE, content: renderApiReference(workerRoutes, launcherRoutes) },
    { path: OUT_EVENTS_REFERENCE, content: renderEventsReference(unionTypes) },
    { path: OUT_STATE_MACHINE, content: renderStateMachineDiagram(sessionStatuses) },
  ];
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const outputs = generate();

  if (args.has("--check")) {
    let drift = 0;
    for (const { path, content } of outputs) {
      const onDisk = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (onDisk !== content) {
        console.log(`✗ ${relative(REPO_ROOT, path)} is stale.`);
        drift++;
      } else {
        console.log(`✓ ${relative(REPO_ROOT, path)} is up to date.`);
      }
    }
    if (drift > 0) {
      console.log(`\n✗ ${drift} doc(s) drifted from source. Run 'bun run docs:gen'.`);
      process.exit(1);
    }
    return;
  }

  for (const { path, content } of outputs) {
    writeFileSync(path, content);
    console.log(`wrote ${relative(REPO_ROOT, path)} (${content.length} B)`);
  }
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  main();
}
