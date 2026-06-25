// ============================================================
// Unit tests for src/worker/github-webhook.ts
//   - HMAC verify: pass / fail / malformed signature / wrong length
//   - Parser: pull_request opened/closed-merged/closed-unmerged
//   - Parser: ping ack, other events -> ignored
// ============================================================

import { describe, it, expect } from "vitest";
import {
  verifyGithubHmac,
  parseGithubWebhook,
  type PullRequestEventPayload,
} from "../src/worker/github-webhook";

const SECRET = "test-secret";

async function sign(body: string, secret = SECRET): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

describe("verifyGithubHmac", () => {
  it("accepts a body signed with the right secret", async () => {
    const body = '{"hello":"world"}';
    const sig = await sign(body);
    expect(
      await verifyGithubHmac({ rawBody: body, signatureHeader: sig, secret: SECRET }),
    ).toBe(true);
  });

  it("rejects when the body is altered", async () => {
    const sig = await sign('{"hello":"world"}');
    expect(
      await verifyGithubHmac({
        rawBody: '{"hello":"WORLD"}',
        signatureHeader: sig,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects when the secret is wrong", async () => {
    const body = '{"x":1}';
    const sig = await sign(body, "other-secret");
    expect(
      await verifyGithubHmac({ rawBody: body, signatureHeader: sig, secret: SECRET }),
    ).toBe(false);
  });

  it("rejects missing signature header", async () => {
    expect(
      await verifyGithubHmac({ rawBody: "x", signatureHeader: null, secret: SECRET }),
    ).toBe(false);
  });

  it("rejects missing secret", async () => {
    expect(
      await verifyGithubHmac({ rawBody: "x", signatureHeader: "sha256=00", secret: "" }),
    ).toBe(false);
  });

  it("rejects wrong-prefix signature", async () => {
    const sig = (await sign("x")).replace("sha256=", "sha1=");
    expect(
      await verifyGithubHmac({ rawBody: "x", signatureHeader: sig, secret: SECRET }),
    ).toBe(false);
  });

  it("rejects wrong-length signature", async () => {
    expect(
      await verifyGithubHmac({
        rawBody: "x",
        signatureHeader: "sha256=deadbeef",
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects non-hex signature characters", async () => {
    // Right length (64 hex chars) but contains non-hex.
    expect(
      await verifyGithubHmac({
        rawBody: "x",
        signatureHeader: "sha256=" + "z".repeat(64),
        secret: SECRET,
      }),
    ).toBe(false);
  });
});

// ---- Parser fixtures ----

function prPayload(overrides: Partial<PullRequestEventPayload> = {}): PullRequestEventPayload {
  return {
    action: "opened",
    number: 42,
    pull_request: {
      number: 42,
      html_url: "https://github.com/duckhoa-uit/lawn/pull/42",
      state: "open",
      merged: false,
      merged_at: null,
      base: { ref: "main" },
      head: { ref: "hermes/abcd1234" },
      user: { login: "duckhoa-uit" },
    },
    repository: { full_name: "duckhoa-uit/lawn" },
    sender: { login: "duckhoa-uit" },
    ...overrides,
  };
}

describe("parseGithubWebhook", () => {
  it("parses a pull_request.opened event", () => {
    const body = JSON.stringify(prPayload());
    const parsed = parseGithubWebhook("pull_request", "del-1", body);
    expect(parsed).toMatchObject({
      kind: "pull_request",
      deliveryId: "del-1",
      prKey: "duckhoa-uit/lawn#42",
      action: "opened",
      merged: false,
      prUrl: "https://github.com/duckhoa-uit/lawn/pull/42",
      senderLogin: "duckhoa-uit",
      repoFullName: "duckhoa-uit/lawn",
    });
  });

  it("parses a pull_request.closed (merged=true)", () => {
    const body = JSON.stringify(
      prPayload({
        action: "closed",
        pull_request: {
          ...prPayload().pull_request,
          state: "closed",
          merged: true,
          merged_at: "2026-06-26T01:23:45Z",
        },
      }),
    );
    const parsed = parseGithubWebhook("pull_request", "del-2", body);
    expect(parsed).toMatchObject({ kind: "pull_request", action: "closed", merged: true });
  });

  it("parses a pull_request.closed (merged=false)", () => {
    const body = JSON.stringify(
      prPayload({
        action: "closed",
        pull_request: {
          ...prPayload().pull_request,
          state: "closed",
          merged: false,
        },
      }),
    );
    const parsed = parseGithubWebhook("pull_request", "del-3", body);
    expect(parsed).toMatchObject({ kind: "pull_request", action: "closed", merged: false });
  });

  it("returns 'ignored' for the GitHub ping event", () => {
    const parsed = parseGithubWebhook("ping", "del-4", '{"zen":"yes"}');
    expect(parsed).toMatchObject({ kind: "ignored", reason: "ping" });
  });

  it("returns 'ignored' for unhandled event types (no follow-up via webhooks)", () => {
    const parsed = parseGithubWebhook("issue_comment", "del-5", '{"action":"created"}');
    expect(parsed).toMatchObject({ kind: "ignored", reason: "issue_comment" });
  });

  it("returns null when X-GitHub-Delivery is missing", () => {
    expect(parseGithubWebhook("pull_request", null, "{}")).toBeNull();
    expect(parseGithubWebhook("pull_request", "", "{}")).toBeNull();
  });

  it("returns null on unparseable JSON", () => {
    expect(parseGithubWebhook("pull_request", "del-6", "not-json")).toBeNull();
  });

  it("returns null when pull_request field is missing", () => {
    expect(
      parseGithubWebhook("pull_request", "del-7", JSON.stringify({ action: "opened" })),
    ).toBeNull();
  });
});
