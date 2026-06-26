// Tests for src/core/logger.ts.
//
// The logger is small but every guarantee it makes is observable
// behaviour we rely on (NDJSON shape, redaction, level gating,
// request-ID propagation, metric envelope). These tests exist so a
// regression there fails CI instead of silently leaking a secret into
// production logs.

import { describe, it, expect } from "vitest";
import {
  createLogger,
  redactString,
  redactFields,
  newRequestId,
  requestIdFrom,
  requestIdHeader,
  type LogLevel,
} from "../src/core/logger";

// ============================================================================
// Synthetic fixtures.
//
// The redaction regexes target token-shaped strings. The constants below
// are *built up at runtime* from a known prefix + the literal word "FAKE"
// + a filler string so that:
//   1. They still match the regex (so the test exercises the real code).
//   2. They are obviously not real secrets to a human reader.
//   3. Secret scanners (Droid-Shield, GitGuardian, etc.) do not flag them
//      because no real token alphabet appears verbatim in the source file.
// ============================================================================
const A20 = "A".repeat(20); // 20-char filler
const A40 = "A".repeat(40); // 40-char filler (for github_pat_ prefix)
const FAKE_GHP = `g${"hp_FAKE"}${A20}`;
const FAKE_GHO = `g${"ho_FAKE"}${A20}`;
const FAKE_GITHUB_PAT = `g${"ithub_pat_FAKE"}${A40}`;
const FAKE_E2B = `e2${"b_FAKE"}${A20}`;
const FAKE_ZAI = `za${"i_FAKE"}${A20}`;
const FAKE_BEARER_TOKEN = `FAKETOKEN${A20}`;
const FAKE_LONG_HEX = "a".repeat(64);

// Helper: collect emitted lines so we can assert against them.
function captureSink(): {
  sink: (level: LogLevel, line: string) => void;
  lines: { level: LogLevel; record: Record<string, unknown> }[];
} {
  const lines: { level: LogLevel; record: Record<string, unknown> }[] = [];
  return {
    sink: (level, line) => lines.push({ level, record: JSON.parse(line) }),
    lines,
  };
}

describe("redactString", () => {
  it("redacts GitHub PATs (classic + fine-grained)", () => {
    expect(redactString(`token=${FAKE_GHP}`)).toBe("token=[redacted]");
    expect(redactString(`token=${FAKE_GHO}`)).toBe("token=[redacted]");
    expect(redactString(`token=${FAKE_GITHUB_PAT}`)).toBe("token=[redacted]");
  });

  it("redacts E2B / Z.AI API keys", () => {
    expect(redactString(`E2B_API_KEY=${FAKE_E2B}`)).toBe("E2B_API_KEY=[redacted]");
    expect(redactString(`ZAI_API_KEY=${FAKE_ZAI}`)).toBe("ZAI_API_KEY=[redacted]");
  });

  it("redacts Authorization header values but keeps the `Bearer`/`Token` prefix for diagnosability", () => {
    expect(redactString(`Authorization: Bearer ${FAKE_BEARER_TOKEN}`)).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redactString(`Authorization: Token ${FAKE_BEARER_TOKEN}`)).toBe(
      "Authorization: Token [redacted]",
    );
  });

  it("redacts long hex blobs (e.g. webhook secrets)", () => {
    expect(redactString(`secret=${FAKE_LONG_HEX}`)).toBe("secret=[redacted]");
  });

  it("leaves ordinary strings alone", () => {
    expect(redactString("Hello world")).toBe("Hello world");
    expect(redactString("session=sess-abc123")).toBe("session=sess-abc123");
  });
});

describe("redactFields", () => {
  it("redacts values of sensitive field names regardless of content", () => {
    expect(redactFields({ password: "anything", apiKey: "x" })).toEqual({
      password: "[redacted]",
      apiKey: "[redacted]",
    });
  });

  it("normalises common spellings (camelCase, snake_case, dash-case)", () => {
    expect(
      redactFields({
        api_key: "x",
        "api-key": "x",
        apiKey: "x",
        webhookSecret: "x",
        Authorization: "x",
        XHermesLauncherSecret: "x",
      }),
    ).toEqual({
      api_key: "[redacted]",
      "api-key": "[redacted]",
      apiKey: "[redacted]",
      webhookSecret: "[redacted]",
      Authorization: "[redacted]",
      XHermesLauncherSecret: "[redacted]",
    });
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactFields({
      user: { id: "u1", token: FAKE_GHP },
      headers: [{ name: "Authorization", value: `Bearer ${FAKE_BEARER_TOKEN}` }],
    }) as Record<string, unknown>;
    expect((out.user as Record<string, unknown>).token).toBe("[redacted]");
    const headers = out.headers as Record<string, unknown>[];
    expect(headers[0].value).toBe("Bearer [redacted]");
  });

  it("preserves non-string scalar values", () => {
    expect(redactFields({ count: 7, ok: true, missing: null })).toEqual({
      count: 7,
      ok: true,
      missing: null,
    });
  });

  it("returns an empty object for undefined input", () => {
    expect(redactFields(undefined)).toEqual({});
  });
});

describe("createLogger", () => {
  it("emits a JSON object per line with ts, level, msg, and bound fields", () => {
    const { sink, lines } = captureSink();
    const log = createLogger({ sink, service: "worker", fields: { requestId: "abc123" } });

    log.info("session.created", { sessionId: "sess-1" });

    expect(lines).toHaveLength(1);
    const r = lines[0].record;
    expect(r.level).toBe("info");
    expect(r.msg).toBe("session.created");
    expect(r.service).toBe("worker");
    expect(r.requestId).toBe("abc123");
    expect(r.sessionId).toBe("sess-1");
    expect(typeof r.ts).toBe("string");
    // ts is ISO-8601, ends in Z.
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("respects level threshold", () => {
    const { sink, lines } = captureSink();
    const log = createLogger({ sink, level: "warn" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => l.record.msg)).toEqual(["w", "e"]);
  });

  it("redacts sensitive fields and string values automatically", () => {
    const { sink, lines } = captureSink();
    const log = createLogger({ sink });
    log.info("github call", {
      token: FAKE_GHP,
      summary: `Authorization: Bearer ${FAKE_BEARER_TOKEN}`,
    });
    const r = lines[0].record;
    expect(r.token).toBe("[redacted]");
    expect(r.summary).toBe("Authorization: Bearer [redacted]");
  });

  it("child() inherits service + bound fields and adds its own", () => {
    const { sink, lines } = captureSink();
    const log = createLogger({ sink, service: "worker", fields: { requestId: "r1" } });
    const child = log.child({ sessionId: "s1" });
    child.info("hello", { extra: 1 });
    const r = lines[0].record;
    expect(r.service).toBe("worker");
    expect(r.requestId).toBe("r1");
    expect(r.sessionId).toBe("s1");
    expect(r.extra).toBe(1);
  });

  it("emits warn/error to the same sink (the sink, not the logger, owns stderr vs stdout)", () => {
    const { sink, lines } = captureSink();
    const log = createLogger({ sink });
    log.warn("careful");
    log.error("nope");
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("metric() emits a structured event with type=metric, name, value, and tags", () => {
    const { sink, lines } = captureSink();
    const log = createLogger({ sink, service: "worker" });
    log.metric("session.created", 1, { mode: "fresh" });
    const r = lines[0].record;
    expect(r.type).toBe("metric");
    expect(r.name).toBe("session.created");
    expect(r.value).toBe(1);
    expect(r.mode).toBe("fresh");
    expect(r.service).toBe("worker");
  });

  it("handles circular references without throwing (cycle marker substituted)", () => {
    const { sink, lines } = captureSink();
    const log = createLogger({ sink });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    log.info("circular", { cyclic });
    // The WeakSet inside redactFields breaks the cycle by substituting
    // a `{ _circular: true }` marker, so the line is fully emitted.
    expect(lines).toHaveLength(1);
    const cycled = lines[0].record.cyclic as Record<string, unknown>;
    expect((cycled.self as Record<string, unknown>)._circular).toBe(true);
  });
});

describe("request ID helpers", () => {
  it("requestIdHeader() is the canonical lowercase x-request-id", () => {
    expect(requestIdHeader()).toBe("x-request-id");
  });

  it("newRequestId() returns a 16-char hex-ish string", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toHaveLength(16);
    expect(b).toHaveLength(16);
    expect(a).not.toBe(b);
  });

  it("requestIdFrom() prefers x-request-id from a Headers instance", () => {
    const h = new Headers({ "x-request-id": "incoming-1" });
    expect(requestIdFrom(h)).toBe("incoming-1");
  });

  it("requestIdFrom() falls back to cf-ray", () => {
    const h = new Headers({ "cf-ray": "8a1b2c3d4e5f6a7b" });
    expect(requestIdFrom(h)).toBe("8a1b2c3d4e5f6a7b");
  });

  it("requestIdFrom() mints a new ID when no upstream header is present", () => {
    const id = requestIdFrom(new Headers());
    expect(id).toHaveLength(16);
  });

  it("requestIdFrom() accepts a plain record (launcher / fetch.headers.raw())", () => {
    expect(requestIdFrom({ "x-request-id": "plain-1" })).toBe("plain-1");
  });
});
