// ============================================================
// Live E2E for the auto-amend webhook path. Fires HMAC-signed
// pull_request_review and check_run deliveries directly at the
// deployed Worker, then waits for the spawn amend session to land
// on GitHub.
//
// Why we ship this:
//   - check_run from a real CI requires a workflow file on the target
//     repo. Pushing one needs `workflow` PAT scope which our fine-grained
//     token doesn't carry. The Checks API also rejects PATs.
//   - The Worker code path is identical whether the request comes from
//     GitHub or from us (HMAC verify is the only auth) — once verified
//     the dispatch + slot machinery is exactly what production runs.
//   - Lets us exercise cap_exceeded / inflight / duplicate_sha without
//     coordinating multiple real reviewer accounts.
//
// Usage:
//   bun run scripts/e2e-autoamend-live.ts \
//     --worker https://hermes-control-plane.duckhoa-dev.workers.dev \
//     --pr-key duckhoa-uit/lawn#9 \
//     --pr-url https://github.com/duckhoa-uit/lawn/pull/9 \
//     --case review|check_run|cap|inflight|duplicate_sha
//
// Requires GITHUB_WEBHOOK_SECRET env (matching the Worker secret).
// ============================================================

import { parseArgs } from "node:util";
import { createHmac } from "node:crypto";

const args = parseArgs({
  options: {
    worker: { type: "string", default: "https://hermes-control-plane.duckhoa-dev.workers.dev" },
    "pr-key": { type: "string" }, // owner/repo#N
    "pr-url": { type: "string" }, // https://github.com/owner/repo/pull/N
    "head-sha": { type: "string", default: "" },
    case: { type: "string", default: "review" },
    reviewer: { type: "string", default: "khoa-centyent" },
  },
});

const WORKER = args.values.worker!;
const PR_KEY = args.values["pr-key"]!;
const PR_URL = args.values["pr-url"]!;
const CASE = args.values.case!;
const REVIEWER = args.values.reviewer!;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const LAUNCHER_SECRET = process.env.HERMES_LAUNCHER_SECRET || "";
if (!PR_KEY || !PR_URL) throw new Error("--pr-key and --pr-url required");
if (!SECRET) throw new Error("GITHUB_WEBHOOK_SECRET env required");
if (!LAUNCHER_SECRET) throw new Error("HERMES_LAUNCHER_SECRET env required (for /pr-index)");

function parsePrKey(s: string): { owner: string; repo: string; number: number } {
  const m = s.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!m) throw new Error(`bad prKey: ${s}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}
const { owner, repo, number } = parsePrKey(PR_KEY);

async function getHeadSha(): Promise<string> {
  if (args.values["head-sha"]) return args.values["head-sha"]!;
  const token = process.env.HERMES_GITHUB_WRITE_TOKEN || "";
  if (!token) throw new Error("--head-sha not given and HERMES_GITHUB_WRITE_TOKEN not set");
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`gh /pulls/${number} ${r.status}: ${await r.text()}`);
  const pr = (await r.json()) as { head: { sha: string; ref: string } };
  return pr.head.sha;
}

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

async function deliverReview(deliveryId: string, headSha: string, body: string): Promise<any> {
  const payload = {
    action: "submitted",
    pull_request: {
      number,
      html_url: PR_URL,
      state: "open",
      head: { sha: headSha, ref: `hermes/${headSha.slice(0, 8)}` },
      base: { ref: "main" },
    },
    review: {
      id: Math.floor(Math.random() * 1e9),
      state: "changes_requested",
      body,
      user: { login: REVIEWER, type: "User" },
      submitted_at: new Date().toISOString(),
    },
    repository: { full_name: `${owner}/${repo}` },
    sender: { login: REVIEWER, type: "User" },
  };
  const bodyStr = JSON.stringify(payload);
  const r = await fetch(`${WORKER}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request_review",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": sign(bodyStr),
    },
    body: bodyStr,
  });
  return { status: r.status, body: await r.json() };
}

async function deliverCheckRunFailed(deliveryId: string, headSha: string, checkName: string): Promise<any> {
  const payload = {
    action: "completed",
    check_run: {
      id: Math.floor(Math.random() * 1e9),
      name: checkName,
      head_sha: headSha,
      status: "completed",
      conclusion: "failure",
      html_url: `https://github.com/${owner}/${repo}/runs/${Date.now()}`,
      details_url: `https://github.com/${owner}/${repo}/actions/runs/${Date.now()}`,
      pull_requests: [{ number, head: { ref: `hermes/${headSha.slice(0, 8)}`, sha: headSha } }],
    },
    repository: { full_name: `${owner}/${repo}` },
    sender: { login: "github-actions[bot]", type: "Bot" },
  };
  const bodyStr = JSON.stringify(payload);
  const r = await fetch(`${WORKER}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "check_run",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": sign(bodyStr),
    },
    body: bodyStr,
  });
  return { status: r.status, body: await r.json() };
}

async function getIndex(): Promise<any> {
  const r = await fetch(`${WORKER}/pr-index?key=${encodeURIComponent(PR_KEY)}`, {
    headers: { "x-hermes-launcher-secret": LAUNCHER_SECRET },
  });
  if (!r.ok) return null;
  return (await r.json() as any).row;
}

async function waitForSlotFree(maxMs = 180_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const row = await getIndex();
    if (!row?.inflightAmendStartedAt) return;
    console.log(`  slot still held by session=${row.inflightSessionId?.slice(0, 8)} count=${row.autofixCount}, waiting…`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`slot did not free within ${maxMs}ms`);
}

(async () => {
  console.log(`worker = ${WORKER}`);
  console.log(`pr     = ${PR_KEY}`);
  console.log(`case   = ${CASE}`);
  const headSha = await getHeadSha();
  console.log(`head   = ${headSha.slice(0, 7)}`);
  const before = await getIndex();
  console.log(`pre-state: autofixCount=${before?.autofixCount} inflight=${!!before?.inflightAmendStartedAt} status=${before?.status}`);

  if (CASE === "review") {
    const res = await deliverReview(`e2e-rev-${Date.now()}`, headSha, "Synthetic review for E2E.");
    console.log("response:", JSON.stringify(res, null, 2));
  } else if (CASE === "check_run") {
    const res = await deliverCheckRunFailed(`e2e-cr-${Date.now()}`, headSha, "hermes-e2e/synthetic");
    console.log("response:", JSON.stringify(res, null, 2));
  } else if (CASE === "duplicate_sha") {
    // first goes through; second on same sha is refused.
    await waitForSlotFree();
    const r1 = await deliverReview(`e2e-dup-${Date.now()}-1`, headSha, "first");
    console.log("first:", JSON.stringify(r1, null, 2));
    await new Promise(r => setTimeout(r, 1000));
    const r2 = await deliverReview(`e2e-dup-${Date.now()}-2`, headSha, "second on same sha");
    console.log("second:", JSON.stringify(r2, null, 2));
  } else if (CASE === "inflight") {
    // first claims slot; second arrives before slot frees → inflight.
    await waitForSlotFree();
    const r1 = await deliverReview(`e2e-inf-${Date.now()}-1`, headSha, "first");
    console.log("first:", JSON.stringify(r1, null, 2));
    // immediately fire second with a DIFFERENT sha-ish (won't conflict on duplicate_sha)
    const r2 = await deliverCheckRunFailed(`e2e-inf-${Date.now()}-2`, headSha + "x", "ci-other");
    console.log("second (parallel):", JSON.stringify(r2, null, 2));
  } else if (CASE === "cap") {
    // fire 4 with different synthetic shas; expect 3 dispatched + 1 cap_exceeded.
    for (let i = 1; i <= 4; i++) {
      await waitForSlotFree();
      const r = await deliverReview(`e2e-cap-${Date.now()}-${i}`, `${headSha.slice(0, -1)}${i}`, `attempt ${i}`);
      console.log(`#${i}:`, JSON.stringify(r, null, 2));
      if (r.body.dispatched) {
        console.log("  waiting 5s before next…");
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  } else {
    throw new Error(`unknown --case: ${CASE}`);
  }

  const after = await getIndex();
  console.log(`post-state: autofixCount=${after?.autofixCount} inflight=${!!after?.inflightAmendStartedAt} lastSha=${after?.lastAmendedSha?.slice(0, 7)}`);
})();
