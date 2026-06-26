// ============================================================
// GitHub webhook verification + parsing for the control plane.
//
// Scope: PR lifecycle + auto-amend on reviewer feedback / CI failure.
// We subscribe to three GitHub event types:
//   - `pull_request`        — lifecycle (merged/closed → archive session)
//   - `pull_request_review` — reviewer "Request changes" → spawn amend
//   - `check_run`           — failure / timed_out → spawn amend
// Follow-up via PR comments / @mentions / issue_comment is explicitly
// out of scope — gateway-driven (Slack/Telegram → Hermes Agent → MCP).
//
// HMAC: GitHub signs the raw body with `X-Hub-Signature-256: sha256=<hex>`.
// We use Web Crypto's HMAC-SHA-256 and compare digests in constant time
// (timing-safe equal over Uint8Array — Workers' crypto.subtle does not
// expose a dedicated timingSafeEqual).
// ============================================================
//
// Event shapes captured here are the minimum we actually read; the
// payloads carry many more fields. Keep these interfaces narrow so the
// compiler complains if upstream renames something we depend on.

export interface PullRequestEventPayload {
  action: "opened" | "closed" | "reopened" | "edited" | "synchronize" | string;
  number: number;
  pull_request: {
    number: number;
    html_url: string;
    state: "open" | "closed";
    merged: boolean;
    merged_at: string | null;
    base: { ref: string };
    head: { ref: string };
    user: { login: string };
  };
  repository: { full_name: string };
  sender: { login: string };
}

/** PR review event. We only act when state === "changes_requested";
 *  approved / commented reviews are routinely posted and dispatching on
 *  them would amend the PR for every drive-by review. */
export interface PullRequestReviewEventPayload {
  action: "submitted" | "edited" | "dismissed" | string;
  pull_request: {
    number: number;
    html_url: string;
    state: "open" | "closed";
    head: { sha: string; ref: string };
    base: { ref: string };
  };
  review: {
    id: number;
    state: "approved" | "changes_requested" | "commented" | "dismissed" | string;
    body: string | null;
    user: { login: string; type?: string };
    submitted_at: string;
  };
  repository: { full_name: string };
  sender: { login: string; type?: string };
}

/** GitHub Actions check_run lifecycle. We act on completed runs with
 *  conclusion failure / timed_out only — `action_required` means a human
 *  workflow approval is pending and is not something an agent fix can
 *  address. */
export interface CheckRunEventPayload {
  action: "completed" | "created" | "rerequested" | "requested_action" | string;
  check_run: {
    id: number;
    name: string;
    head_sha: string;
    status: "queued" | "in_progress" | "completed" | string;
    conclusion:
      | "success"
      | "failure"
      | "timed_out"
      | "cancelled"
      | "neutral"
      | "skipped"
      | "stale"
      | "action_required"
      | null;
    html_url: string;
    details_url?: string;
    pull_requests: Array<{ number: number; head: { ref: string; sha: string } }>;
  };
  repository: { full_name: string };
  sender: { login: string; type?: string };
}

export type ParsedWebhook =
  | {
      kind: "pull_request";
      deliveryId: string;
      prKey: string; // "owner/repo#N"
      action: PullRequestEventPayload["action"];
      merged: boolean;
      prUrl: string;
      senderLogin: string;
      repoFullName: string;
    }
  | {
      kind: "review_changes_requested";
      deliveryId: string;
      prKey: string;
      prUrl: string;
      headSha: string;
      headBranch: string;
      reviewerLogin: string;
      reviewerType?: string; // "User" | "Bot"
      senderLogin: string;
      senderType?: string;
      reviewBody: string; // may be empty if reviewer only used inline comments
      reviewId: number;
      repoFullName: string;
    }
  | {
      kind: "check_run_failed";
      deliveryId: string;
      prKey: string; // resolved from check_run.pull_requests[0]
      prUrl: string;
      headSha: string;
      checkName: string;
      conclusion: "failure" | "timed_out";
      detailsUrl: string;
      senderLogin: string;
      senderType?: string;
      repoFullName: string;
    }
  | { kind: "ignored"; deliveryId: string; reason: string };
// `ignored` covers events we explicitly do not act on (e.g. ping,
// pull_request_review, anything we haven't wired up). Webhook handler
// returns 200 for these so GitHub doesn't retry.
//
// Note: we deliberately do NOT parse issue_comment / pull_request_review /
// check_run. Follow-up flow is gateway-driven, not GitHub-driven.

export interface VerifyArgs {
  /** Raw request body — must be the exact bytes GitHub signed. */
  rawBody: string;
  /** Value of the `X-Hub-Signature-256` header. */
  signatureHeader: string | null;
  /** GITHUB_WEBHOOK_SECRET. */
  secret: string;
}

/** Verify the X-Hub-Signature-256 HMAC against the request body.
 *  Returns false on malformed input rather than throwing so the handler
 *  can decide between 400 (bad signature shape) and 401 (mismatch). */
export async function verifyGithubHmac(args: VerifyArgs): Promise<boolean> {
  if (!args.signatureHeader || !args.secret) return false;
  const expectedPrefix = "sha256=";
  if (!args.signatureHeader.startsWith(expectedPrefix)) return false;
  const providedHex = args.signatureHeader.slice(expectedPrefix.length);

  // Compute our own HMAC.
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(args.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(args.rawBody));
  const expected = new Uint8Array(sigBuf);

  // Decode the provided hex.
  if (providedHex.length !== expected.length * 2) return false;
  const provided = new Uint8Array(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const hi = parseInt(providedHex[i * 2], 16);
    const lo = parseInt(providedHex[i * 2 + 1], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return false;
    provided[i] = (hi << 4) | lo;
  }

  // Constant-time compare: XOR every byte, OR into an accumulator.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ provided[i];
  return diff === 0;
}

// --- Per-event parsers ------------------------------------------------------
// Each handler owns one X-GitHub-Event value. They return null only when the
// payload is structurally invalid (missing required objects). "We don't want
// to act on this" returns a kind:"ignored" record so the caller can ack 200.

function parsePullRequest(body: unknown, deliveryId: string): ParsedWebhook | null {
  const p = body as PullRequestEventPayload;
  if (!p.pull_request || !p.repository) return null;
  return {
    kind: "pull_request",
    deliveryId,
    prKey: `${p.repository.full_name}#${p.pull_request.number}`,
    action: p.action,
    merged: p.pull_request.merged === true,
    prUrl: p.pull_request.html_url,
    senderLogin: p.sender?.login ?? "",
    repoFullName: p.repository.full_name,
  };
}

function parsePullRequestReview(body: unknown, deliveryId: string): ParsedWebhook | null {
  const p = body as PullRequestReviewEventPayload;
  if (!p.pull_request || !p.review || !p.repository) return null;
  // We only dispatch on `submitted` + state `changes_requested`.
  // `commented` reviews (no state change) and `approved` reviews are
  // common drive-by interactions — amending on them would spam the PR.
  if (p.action !== "submitted" || p.review.state !== "changes_requested") {
    return {
      kind: "ignored",
      deliveryId,
      reason: `pull_request_review.${p.action}/${p.review.state}`,
    };
  }
  return {
    kind: "review_changes_requested",
    deliveryId,
    prKey: `${p.repository.full_name}#${p.pull_request.number}`,
    prUrl: p.pull_request.html_url,
    headSha: p.pull_request.head?.sha ?? "",
    headBranch: p.pull_request.head?.ref ?? "",
    reviewerLogin: p.review.user?.login ?? "",
    reviewerType: p.review.user?.type,
    senderLogin: p.sender?.login ?? "",
    senderType: p.sender?.type,
    reviewBody: p.review.body ?? "",
    reviewId: p.review.id,
    repoFullName: p.repository.full_name,
  };
}

function parseCheckRun(body: unknown, deliveryId: string): ParsedWebhook | null {
  const p = body as CheckRunEventPayload;
  if (!p.check_run || !p.repository) return null;
  if (p.action !== "completed") {
    return { kind: "ignored", deliveryId, reason: `check_run.${p.action}` };
  }
  const conclusion = p.check_run.conclusion;
  if (conclusion !== "failure" && conclusion !== "timed_out") {
    return { kind: "ignored", deliveryId, reason: `check_run.${conclusion ?? "null"}` };
  }
  // The PR(s) this check_run belongs to. A push to a branch with no
  // open PR has an empty list — skip those (the check_run will still
  // arrive but no Hermes session to amend).
  const prs = p.check_run.pull_requests ?? [];
  if (prs.length === 0) {
    return { kind: "ignored", deliveryId, reason: "check_run.no_pr" };
  }
  // GitHub Actions only ever ties a check_run to a single PR; take the
  // first one. (If a sha is shared by multiple PRs, we'd amend whichever
  // GitHub listed first — corner case, not seen in practice.)
  const pr = prs[0];
  return {
    kind: "check_run_failed",
    deliveryId,
    prKey: `${p.repository.full_name}#${pr.number}`,
    prUrl: `https://github.com/${p.repository.full_name}/pull/${pr.number}`,
    headSha: p.check_run.head_sha,
    checkName: p.check_run.name,
    conclusion,
    detailsUrl: p.check_run.details_url ?? p.check_run.html_url,
    senderLogin: p.sender?.login ?? "",
    senderType: p.sender?.type,
    repoFullName: p.repository.full_name,
  };
}

/** Parse a verified webhook delivery into the small subset we act on.
 *  `eventHeader` is the value of `X-GitHub-Event`; `deliveryHeader` is
 *  `X-GitHub-Delivery`. Both come straight off `request.headers`. */
export function parseGithubWebhook(
  eventHeader: string | null,
  deliveryHeader: string | null,
  rawBody: string,
): ParsedWebhook | null {
  const deliveryId = deliveryHeader ?? "";
  if (!deliveryId) return null;

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;

  // GitHub ping (sent when the webhook is first installed). Always ack.
  if (eventHeader === "ping") return { kind: "ignored", deliveryId, reason: "ping" };
  if (eventHeader === "pull_request") return parsePullRequest(body, deliveryId);
  if (eventHeader === "pull_request_review") return parsePullRequestReview(body, deliveryId);
  if (eventHeader === "check_run") return parseCheckRun(body, deliveryId);

  // Everything else (issue_comment, pull_request_review_comment, push, …)
  // we acknowledge but do not act on. Follow-up is gateway-driven.
  return { kind: "ignored", deliveryId, reason: eventHeader ?? "unknown" };
}
