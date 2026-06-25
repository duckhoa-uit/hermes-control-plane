// ============================================================
// GitHub webhook verification + parsing for the control plane.
//
// Scope: lifecycle only. We subscribe to `pull_request` events so we
// can flip the PR Index row's status when a PR is merged/closed and
// transition the parent session to archived. Follow-up prompts and
// auto-trigger via mentions are explicitly out of scope — those go
// through the MCP gateway (Slack/Telegram → Hermes Agent → MCP) and
// never look at webhook payloads.
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
  if (eventHeader === "ping") {
    return { kind: "ignored", deliveryId, reason: "ping" };
  }

  if (eventHeader === "pull_request") {
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

  // Everything else (issue_comment, pull_request_review, check_run, …)
  // we acknowledge but do not act on. Follow-up is gateway-driven.
  return { kind: "ignored", deliveryId, reason: eventHeader ?? "unknown" };
}
