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
  type PullRequestReviewEventPayload,
  type CheckRunEventPayload,
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
    expect(await verifyGithubHmac({ rawBody: body, signatureHeader: sig, secret: SECRET })).toBe(
      true,
    );
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
    expect(await verifyGithubHmac({ rawBody: body, signatureHeader: sig, secret: SECRET })).toBe(
      false,
    );
  });

  it("rejects missing signature header", async () => {
    expect(await verifyGithubHmac({ rawBody: "x", signatureHeader: null, secret: SECRET })).toBe(
      false,
    );
  });

  it("rejects missing secret", async () => {
    expect(await verifyGithubHmac({ rawBody: "x", signatureHeader: "sha256=00", secret: "" })).toBe(
      false,
    );
  });

  it("rejects wrong-prefix signature", async () => {
    const sig = (await sign("x")).replace("sha256=", "sha1=");
    expect(await verifyGithubHmac({ rawBody: "x", signatureHeader: sig, secret: SECRET })).toBe(
      false,
    );
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

// ---- pull_request_review fixtures + tests ----

function reviewPayload(
  overrides: Partial<PullRequestReviewEventPayload> = {},
): PullRequestReviewEventPayload {
  return {
    action: "submitted",
    pull_request: {
      number: 42,
      html_url: "https://github.com/duckhoa-uit/lawn/pull/42",
      state: "open",
      head: { sha: "abcdef0123456789", ref: "hermes/abcd1234" },
      base: { ref: "main" },
    },
    review: {
      id: 12345,
      state: "changes_requested",
      body: "Please rename foo -> bar and tighten the loop.",
      user: { login: "reviewer1", type: "User" },
      submitted_at: "2026-06-26T01:23:45Z",
    },
    repository: { full_name: "duckhoa-uit/lawn" },
    sender: { login: "reviewer1", type: "User" },
    ...overrides,
  };
}

describe("parseGithubWebhook — pull_request_review", () => {
  it("dispatches changes_requested submissions", () => {
    const body = JSON.stringify(reviewPayload());
    const parsed = parseGithubWebhook("pull_request_review", "del-rev-1", body);
    expect(parsed).toMatchObject({
      kind: "review_changes_requested",
      prKey: "duckhoa-uit/lawn#42",
      prUrl: "https://github.com/duckhoa-uit/lawn/pull/42",
      headSha: "abcdef0123456789",
      headBranch: "hermes/abcd1234",
      reviewerLogin: "reviewer1",
      reviewerType: "User",
      reviewBody: "Please rename foo -> bar and tighten the loop.",
      reviewId: 12345,
      senderLogin: "reviewer1",
    });
  });

  it("ignores approved reviews", () => {
    const body = JSON.stringify(
      reviewPayload({
        review: { ...reviewPayload().review, state: "approved" },
      }),
    );
    const parsed = parseGithubWebhook("pull_request_review", "del-rev-2", body);
    expect(parsed).toMatchObject({
      kind: "ignored",
      reason: "pull_request_review.submitted/approved",
    });
  });

  it("ignores commented reviews (no state change)", () => {
    const body = JSON.stringify(
      reviewPayload({
        review: { ...reviewPayload().review, state: "commented", body: "lgtm-ish" },
      }),
    );
    const parsed = parseGithubWebhook("pull_request_review", "del-rev-3", body);
    expect(parsed).toMatchObject({
      kind: "ignored",
      reason: "pull_request_review.submitted/commented",
    });
  });

  it("ignores review.edited / review.dismissed (only submitted dispatches)", () => {
    const body = JSON.stringify(reviewPayload({ action: "edited" }));
    const parsed = parseGithubWebhook("pull_request_review", "del-rev-4", body);
    expect(parsed).toMatchObject({ kind: "ignored", reason: /pull_request_review\.edited/ });
  });

  it("returns null on malformed payload (missing review)", () => {
    const bad = JSON.stringify({
      action: "submitted",
      pull_request: reviewPayload().pull_request,
      repository: reviewPayload().repository,
    });
    expect(parseGithubWebhook("pull_request_review", "del-rev-5", bad)).toBeNull();
  });

  it("preserves empty review body (reviewer may only use inline comments)", () => {
    const body = JSON.stringify(
      reviewPayload({
        review: { ...reviewPayload().review, body: null },
      }),
    );
    const parsed = parseGithubWebhook("pull_request_review", "del-rev-6", body);
    expect((parsed as any).reviewBody).toBe("");
  });
});

// ---- check_run fixtures + tests ----

function checkRunPayload(overrides: Partial<CheckRunEventPayload> = {}): CheckRunEventPayload {
  return {
    action: "completed",
    check_run: {
      id: 9999,
      name: "ci / test",
      head_sha: "abcdef0123456789",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/duckhoa-uit/lawn/runs/9999",
      details_url: "https://github.com/duckhoa-uit/lawn/actions/runs/9999",
      pull_requests: [{ number: 42, head: { ref: "hermes/abcd1234", sha: "abcdef0123456789" } }],
    },
    repository: { full_name: "duckhoa-uit/lawn" },
    sender: { login: "github-actions[bot]", type: "Bot" },
    ...overrides,
  };
}

describe("parseGithubWebhook — check_run", () => {
  it("dispatches conclusion=failure", () => {
    const parsed = parseGithubWebhook("check_run", "del-cr-1", JSON.stringify(checkRunPayload()));
    expect(parsed).toMatchObject({
      kind: "check_run_failed",
      prKey: "duckhoa-uit/lawn#42",
      headSha: "abcdef0123456789",
      checkName: "ci / test",
      conclusion: "failure",
      detailsUrl: "https://github.com/duckhoa-uit/lawn/actions/runs/9999",
    });
  });

  it("dispatches conclusion=timed_out", () => {
    const parsed = parseGithubWebhook(
      "check_run",
      "del-cr-2",
      JSON.stringify(
        checkRunPayload({
          check_run: { ...checkRunPayload().check_run, conclusion: "timed_out" },
        }),
      ),
    );
    expect(parsed).toMatchObject({ kind: "check_run_failed", conclusion: "timed_out" });
  });

  it("ignores conclusion=success", () => {
    const parsed = parseGithubWebhook(
      "check_run",
      "del-cr-3",
      JSON.stringify(
        checkRunPayload({
          check_run: { ...checkRunPayload().check_run, conclusion: "success" },
        }),
      ),
    );
    expect(parsed).toMatchObject({ kind: "ignored", reason: "check_run.success" });
  });

  it("ignores conclusion=cancelled / neutral / skipped / action_required", () => {
    for (const c of ["cancelled", "neutral", "skipped", "action_required", null] as const) {
      const parsed = parseGithubWebhook(
        "check_run",
        `del-cr-${c}`,
        JSON.stringify(
          checkRunPayload({
            check_run: { ...checkRunPayload().check_run, conclusion: c as any },
          }),
        ),
      );
      expect(parsed).toMatchObject({ kind: "ignored" });
    }
  });

  it("ignores check_run.created / requested_action / rerequested (only completed dispatches)", () => {
    const parsed = parseGithubWebhook(
      "check_run",
      "del-cr-act",
      JSON.stringify(checkRunPayload({ action: "created" })),
    );
    expect(parsed).toMatchObject({ kind: "ignored", reason: /check_run\.created/ });
  });

  it("ignores check_run with no associated PR (push to branch w/o open PR)", () => {
    const parsed = parseGithubWebhook(
      "check_run",
      "del-cr-nopr",
      JSON.stringify(
        checkRunPayload({
          check_run: { ...checkRunPayload().check_run, pull_requests: [] },
        }),
      ),
    );
    expect(parsed).toMatchObject({ kind: "ignored", reason: "check_run.no_pr" });
  });
});
