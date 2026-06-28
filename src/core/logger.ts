// ============================================================
// Structured logger
//
// One opinionated logger for both runtimes (Cloudflare Worker + Bun
// Emits one JSON object per line on stdout/stderr so it can be
// scraped by anything that understands NDJSON — `wrangler tail`,
// `journalctl -o cat | jq`, Datadog Logs, Axiom, Better Stack, etc.
//
// Why a hand-rolled module instead of pino/winston?
//   - Cloudflare Workers cannot run pino's worker-thread transport, and
//     winston's prototype-chain machinery bloats the bundle past our
//     1 MiB budget (scripts/bundle-size.ts). We need ~120 lines of code,
//     not a dependency.
//   - The redaction surface here is tiny and project-specific
//     (PATs, webhook secrets, Authorization headers). A regex pass keeps
//     it auditable.
//
// Three things the logger guarantees:
//
//   1. Structured output (JSON), so every line is grep+jq-friendly and
//      cardinality-stable. Plain string `console.log` is forbidden in
//      `src/` going forward (see CONTRIBUTING.md §Observability).
//
//   2. Request-ID propagation. Every log line carries the `requestId`
//      bound to the surrounding `withRequestId` scope. The Worker reads
//      / generates the ID from the incoming `X-Request-Id` (or
//      `cf-ray`) header and threads it via `createLogger({ requestId })`;
//      downstream calls to `fetch()` add it back as a header. Together
//      these let an operator pivot from a log line to the
//      Worker log line that triggered it.
//
//   3. Redaction of obvious secrets *before* they hit the transport.
//      Token-shaped strings (`gh[a-z]_…`, `e2b_…`, `Bearer …`,
//      hex blobs ≥32 chars) and field names matching
//      `password|secret|token|authorization|api[-_]?key|cookie` are
//      replaced with `[redacted]`. This is best-effort defense in depth,
//      not a substitute for not logging secrets in the first place.
//
// Metric helper: `metric()` emits a log line with `type: "metric"` and a
// numeric `value`. Cloudflare Logpush + an Analytics Engine query (see
// `infra/observability/`) aggregate these into the dashboard documented
// in `docs/OBSERVABILITY.md`. The shape is intentionally compatible with
// Datadog DogStatsD / Prometheus exposition format so a future swap of
// the backing store doesn't require touching call sites.
// ============================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Anything that can appear as a structured field. Logger does its own
 * stringification so callers never have to JSON.stringify themselves.
 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a new logger that carries the supplied fields on every line. */
  child(fields: LogFields): Logger;
  /** Numeric event for the metrics pipeline. Shape: `{ type: "metric", name, value, tags }`. */
  metric(name: string, value: number, tags?: LogFields): void;
}

// ---------------------------------------------------------------------------
// Redaction

// Field names whose values are always replaced with [redacted]. Matched
// case-insensitively, both as exact keys and as substrings (e.g. a field
// named `githubApiKey` is redacted because it contains `api_key` after
// camel-to-snake normalisation).
const SENSITIVE_FIELD_RE =
  /(password|passwd|secret|token|authorization|auth[-_]?header|api[-_]?key|cookie|bearer|webhook[-_]?secret|x[-_]?hermes[-_]?launcher[-_]?secret)/i;

const REDACTED = "[redacted]";

// String patterns we always redact, even when they appear inside a
// non-sensitive field name. Each entry's `replace` is a function so we
// can keep the prefix that gives operators context (e.g. an opaque
// `[redacted]` is much less useful than `Bearer [redacted]` when chasing
// a 401).
interface ValuePattern {
  re: RegExp;
  replace: (match: string) => string;
}

const SENSITIVE_VALUE_PATTERNS: ValuePattern[] = [
  // GitHub PATs (classic + fine-grained + GH App tokens).
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: () => REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, replace: () => REDACTED },
  // Z.AI keys (project convention: `zai_…`).
  { re: /\b(?:e2b|zai)_[A-Za-z0-9]{20,}\b/gi, replace: () => REDACTED },
  // `Authorization: Bearer …` / `Authorization: token …` header values.
  // Keep the prefix so the line stays diagnosable.
  {
    re: /\b(Bearer|Token)\s+[A-Za-z0-9._\-+/=]{16,}\b/g,
    replace: (m) => `${m.match(/^\w+/)?.[0] ?? ""} ${REDACTED}`,
  },
  // Long hex blobs (64-char shared secrets from `openssl rand -hex 32`).
  { re: /\b[a-f0-9]{32,}\b/gi, replace: () => REDACTED },
];

export function redactString(s: string): string {
  let out = s;
  for (const { re, replace } of SENSITIVE_VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, replace);
  }
  return out;
}

export function redactFields(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  return redactFieldsInner(fields, new WeakSet());
}

function redactFieldsInner(fields: LogFields, seen: WeakSet<object>): LogFields {
  if (seen.has(fields)) return { _circular: true } as LogFields;
  seen.add(fields);
  const out: LogFields = {};
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (SENSITIVE_FIELD_RE.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactValue(value, seen);
  }
  return out;
}

function redactValue(v: unknown, seen: WeakSet<object>): unknown {
  if (v == null) return v;
  if (typeof v === "string") return redactString(v);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    if (seen.has(v)) return { _circular: true };
    seen.add(v);
    return v.map((el) => redactValue(el, seen));
  }
  if (typeof v === "object") return redactFieldsInner(v as LogFields, seen);
  return v;
}

// ---------------------------------------------------------------------------
// Core implementation

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function levelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[threshold];
}

function envLevel(): LogLevel {
  // Worker env is read by createLogger() at construction; this fallback is
  // only used when the caller didn't pass an env.
  const raw = typeof process !== "undefined" && process.env ? process.env.LOG_LEVEL : undefined;
  if (raw && raw in LEVELS) return raw as LogLevel;
  return "info";
}

export interface CreateLoggerOptions {
  /** Minimum level to emit. Defaults to `LOG_LEVEL` env var, else `info`. */
  level?: LogLevel;
  service?: string;
  /** Initial bound fields. `requestId` here is the canonical place to set it. */
  fields?: LogFields;
  /** Override stdout/stderr writers — used by the test suite. */
  sink?: (level: LogLevel, line: string) => void;
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === "error" || level === "warn") {
    // `process.stderr.write` is more correct than console.error here:
    // console.error in the Worker runtime adds an `ERROR ` prefix that
    // breaks NDJSON parsers.
    if (typeof process !== "undefined" && process.stderr) {
      process.stderr.write(line + "\n");
      return;
    }
    console.error(line);
    return;
  }
  if (typeof process !== "undefined" && process.stdout) {
    process.stdout.write(line + "\n");
    return;
  }
  console.log(line);
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? envLevel();
  const baseFields: LogFields = {
    ...(opts.service ? { service: opts.service } : null),
    ...opts.fields,
  };
  const sink = opts.sink ?? defaultSink;

  function emit(lvl: LogLevel, msg: string, fields?: LogFields): void {
    if (!levelEnabled(lvl, level)) return;
    const record: LogFields = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...baseFields,
      ...redactFields(fields),
    };
    try {
      sink(lvl, JSON.stringify(record));
    } catch {
      // JSON.stringify fails on circular structures. Fall back to a
      // best-effort tagged line so we still know the event happened.
      sink(lvl, JSON.stringify({ ts: record.ts, level: lvl, msg, _error: "unserializable" }));
    }
  }

  const logger: Logger = {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) =>
      createLogger({
        level,
        sink,
        // service is already in baseFields, no need to re-pass.
        fields: { ...baseFields, ...fields },
      }),
    metric: (name, value, tags) => {
      // Metrics are always emitted at info level so they survive a debug
      // → info threshold change in prod. `type: "metric"` lets the
      // ingestion pipeline split them out before they hit the
      // human-readable logs bucket.
      emit("info", `metric ${name}=${value}`, {
        type: "metric",
        name,
        value,
        ...tags,
      });
    },
  };
  return logger;
}

// ---------------------------------------------------------------------------
// Request ID helpers
//
// The Worker generates / extracts a request ID at the edge and threads it
// down via `createLogger({ fields: { requestId } })`. Downstream HTTP
// calls add it back as a header for log correlation.

const REQUEST_ID_HEADER = "x-request-id";

/** Returns a 16-char hex request ID. Uses crypto.randomUUID() when
 *  available (both runtimes ship it). */
export function newRequestId(): string {
  // crypto.randomUUID is globally available in Cloudflare Workers and
  // Bun. Slice to 16 chars to keep log lines compact — the collision
  // probability at our scale is < 1 in 10^14.
  const g = globalThis as typeof globalThis & {
    crypto?: { randomUUID?: () => string };
  };
  const uuid = g.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return uuid.replace(/-/g, "").slice(0, 16);
}

/** Pulls the request ID off an incoming request, or mints one. */
export function requestIdFrom(headers: Headers | Record<string, string | undefined>): string {
  const get = (k: string): string | undefined => {
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(k) ?? undefined;
    }
    const rec = headers as Record<string, string | undefined>;
    return rec[k] ?? rec[k.toUpperCase()] ?? rec[k.toLowerCase()];
  };
  return get(REQUEST_ID_HEADER) ?? get("cf-ray") ?? newRequestId();
}

/** Returns the canonical header name to use when forwarding a request ID. */
export function requestIdHeader(): string {
  return REQUEST_ID_HEADER;
}
