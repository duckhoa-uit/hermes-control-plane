// ============================================================
// Hermes Control Plane - Worker API
// Routes: create session, get session, WS stream, approve/deny, abort, create PR
// ============================================================

import { SessionDurableObject } from "./session-do";
import { PrIndexDurableObject, getPrIndexStub } from "./pr-index-do";
import { verifyGithubHmac, parseGithubWebhook } from "./github-webhook";
import type { PromptResult } from "./session-do";
import type { ProjectProfile, Session, HermesEvent, SessionArtifacts } from "../core/types";
import { timingSafeEqualStrings } from "../core/secrets";
import { createLogger, requestIdFrom } from "../core/logger";

// RPC contract surface — explicit interface so TS does not have to walk the
// full DO class (whose return shapes contain Record<string, unknown> which
// fails CF's Rpc.Serializable<T> check). The DO class implements the same
// signatures.
interface SessionDORpc {
  initSession(
    profile: ProjectProfile,
    taskDescription: string,
    controlBaseUrl: string,
    amendPrUrl?: string,
    branchSuffix?: string,
  ): Promise<Session & { runnerToken: string | null }>;
  getState(): Promise<{
    session: Session | null;
    events: HermesEvent[];
    artifacts: SessionArtifacts | null;
    repoUrl: string | null;
    baseBranch: string | null;
  }>;
  approveRequest(requestId: string): Promise<{ ok: true }>;
  abortSession(): Promise<{ ok: true }>;
  createPR(): Promise<{ ok: true }>;
  setRepoInstructions(input: {
    source: "AGENTS.md" | "CLAUDE.md" | "CONVENTIONS.md";
    content: string;
  }): Promise<{ ok: true }>;
  sendPrompt(text: string): Promise<PromptResult>;
  ingestPrLifecycleEvent(input: {
    merged: boolean;
    prUrl: string;
    deliveryId: string;
    senderLogin: string;
  }): Promise<{ ok: true; archived: boolean }>;
  appendAutofixEvent(input: {
    triggered: boolean;
    trigger: "review_changes_requested" | "check_run_failed";
    deliveryId: string;
    headSha: string;
    newSessionId?: string;
    skipReason?: string;
    reviewerLogin?: string;
    checkName?: string;
    detailsUrl?: string;
  }): Promise<{ ok: true }>;
}

// Cast helper: the DO stub really does implement these methods at runtime,
// but workers-types' Rpc.Provider<T> resolves to `never` here because our
// payloads use `Record<string, unknown>`. Use a single cast so the rest of
// this file stays type-safe.
interface PrIndexDORpc {
  lookup(prKey: string): Promise<{
    sessionId: string;
    ownerLogin: string;
    status: "open" | "merged" | "closed";
    autofixCount: number;
  } | null>;
  recordDelivery(prKey: string, deliveryId: string): Promise<boolean>;
  markStatus(prKey: string, status: "open" | "merged" | "closed"): Promise<unknown>;
  register(prKey: string, sessionId: string, ownerLogin: string): Promise<unknown>;
  incrementAutofix(prKey: string): Promise<number | null>;
  unregister(prKey: string): Promise<boolean>;
  tryClaimAmendSlot(
    prKey: string,
    headSha: string,
    sessionId: string,
    cap: number,
  ): Promise<
    | { ok: true; autofixCount: number }
    | { ok: false; reason: "unknown_pr" | "cap_exceeded" | "duplicate_sha" | "inflight" }
  >;
  releaseAmendSlot(prKey: string, sessionId: string): Promise<void>;
  rollbackAmendClaim(prKey: string, sessionId: string): Promise<void>;
  transferAmendSlot(prKey: string, newSessionId: string): Promise<void>;
}

function asPrIndex(stub: unknown): PrIndexDORpc {
  return stub as PrIndexDORpc;
}

function asRpc(stub: unknown): SessionDORpc {
  return stub as SessionDORpc;
}

export { SessionDurableObject, PrIndexDurableObject };

// ---- In-memory project profiles (MVP: replace with D1 later) ----

const DEFAULT_PROFILE: ProjectProfile = {
  id: "default",
  name: "Default Project",
  repoUrl: "",
  defaultBranch: "main",
  model: "zai-coding-plan/glm-5.2",
  allowedTools: ["read", "edit", "bash", "grep", "glob"],
  approvalPolicy: {
    autoAllow: ["file.read", "file.edit", "test.run"],
    requireApproval: ["git.push", "pr.create", "shell.destructive"],
  },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

const PROMPT_STATUS_BY_KIND: Record<string, number> = {
  terminal: 410,
  no_resume: 409,
  queued: 202,
  ok: 200,
};

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- CORS ----
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Generate (or accept) a request ID and bind it for the rest of the
    // request. Every log line emitted under `log` carries `requestId`, and
    // downstream fetch()/RPC calls echo it back via the X-Request-Id
    // header so the launcher + DO logs stay correlatable.
    const requestId = requestIdFrom(request.headers);
    const log = createLogger({
      service: "worker",
      fields: { requestId },
    });

    const startedAt = Date.now();
    try {
      log.debug("request.received", {
        method: request.method,
        path,
        upgrade: request.headers.get("Upgrade") ?? undefined,
      });
      const resp = await dispatchRoute(request, env, url, path);
      const status = resp?.status ?? 404;
      log.info("request.completed", {
        method: request.method,
        path,
        status,
        durationMs: Date.now() - startedAt,
      });
      log.metric("worker.request", 1, { path, status });
      if (resp) return withRequestId(resp, requestId);
      return withRequestId(
        new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: CORS_HEADERS,
        }),
        requestId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error("request.failed", {
        method: request.method,
        path,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      log.metric("worker.request", 1, { path, status: 500 });
      return withRequestId(
        new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: CORS_HEADERS,
        }),
        requestId,
      );
    }
  },
};

// Echo the request ID back to the caller so a client can paste it into a
// bug report and an operator can grep for it across both runtimes. We
// mutate `resp.headers` in place when possible (the body / status are
// already set by the caller, and re-wrapping in `new Response(resp.body, …)`
// would detach a WebSocket attached to the response — DO upgrade responses
// carry one).
function withRequestId(resp: Response, requestId: string): Response {
  try {
    resp.headers.set("x-request-id", requestId);
  } catch {
    // Some test shims hand back frozen Headers. We could rebuild the
    // Response here, but doing so drops `resp.webSocket`, which is the
    // entire point of WS upgrade responses. Falling through silently is
    // strictly better than breaking real callers; the request-id is also
    // already in every log line, so the only loss is the response header.
  }
  return resp;
}

/** Returns a Response when a route matches; null lets the caller emit 404. */
async function dispatchRoute(
  request: Request,
  env: CloudflareEnv,
  url: URL,
  path: string,
): Promise<Response | null> {
  // Top-level fixed paths.
  if (path === "/health" || path === "/") {
    return new Response(JSON.stringify({ status: "ok", service: "hermes-control-plane" }), {
      headers: CORS_HEADERS,
    });
  }
  if (path === "/pr-index" && request.method === "GET") {
    return handlePrIndexLookup(request, env, url);
  }
  if (path === "/webhooks/github" && request.method === "POST") {
    return handleGithubWebhook(request, env);
  }
  if (path === "/sessions" && request.method === "POST") {
    return handleCreateSession(request, env, url);
  }

  // WebSocket upgrades on /sessions/:id/{stream,runner} → pass through to DO.
  const wsMatch = path.match(/^\/sessions\/([^/]+)\/(stream|runner)$/);
  if (request.headers.get("Upgrade") === "websocket" && wsMatch) {
    return handleSessionWsUpgrade(request, env, wsMatch[1], wsMatch[2]);
  }

  // Per-session sub-routes. The /sessions/:id GET also lives here so it
  // can't be confused with the POST handlers above.
  return dispatchSessionSubroute(request, env, path);
}

async function dispatchSessionSubroute(
  request: Request,
  env: CloudflareEnv,
  path: string,
): Promise<Response | null> {
  if (path.startsWith("/sessions/") && request.method === "GET") {
    return handleGetSessionState(env, path);
  }
  if (request.method !== "POST") return null;
  if (path.endsWith("/approve")) return handleApprove(request, env, path);
  if (path.endsWith("/abort")) return handleAbort(env, path);
  if (path.endsWith("/prompt")) return handlePrompt(request, env, path);
  if (path.endsWith("/repo-instructions")) return handleRepoInstructions(request, env, path);
  if (path.endsWith("/create-pr")) return handleCreatePr(env, path);
  return null;
}

// --- Route handlers --------------------------------------------------------
// Pulled out of the fetch router so each one stays under the project's
// per-function complexity / size budget. Each handler is responsible for
// the request → response mapping for exactly one route + method pair.

async function handlePrIndexLookup(
  request: Request,
  env: CloudflareEnv,
  url: URL,
): Promise<Response> {
  if (!env.LAUNCHER_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "launcher secret not configured" }), {
      status: 503,
      headers: CORS_HEADERS,
    });
  }
  const provided = request.headers.get("x-hermes-launcher-secret") ?? "";
  if (!timingSafeEqualStrings(provided, env.LAUNCHER_SHARED_SECRET)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: CORS_HEADERS,
    });
  }
  const key = url.searchParams.get("key");
  if (!key) {
    return new Response(JSON.stringify({ error: "missing ?key=" }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }
  const row = await asPrIndex(getPrIndexStub(env)).lookup(key);
  if (!row) {
    return new Response(JSON.stringify({ error: "not found", key }), {
      status: 404,
      headers: CORS_HEADERS,
    });
  }
  return new Response(JSON.stringify({ row }), { headers: CORS_HEADERS });
}

async function handleCreateSession(
  request: Request,
  env: CloudflareEnv,
  url: URL,
): Promise<Response> {
  const body = await request.json<{
    projectId: string;
    taskDescription: string;
    repoUrl?: string;
    profile?: Partial<ProjectProfile>;
    // Set by the launcher when this is an amend session.
    amendPrUrl?: string;
    // PR #A / A1: optional readable suffix, see provision.ts.
    branchSuffix?: string;
  }>();

  // Build profile. LLM credentials (ZAI_API_KEY etc.) and any other
  // per-session env vars are injected host-side by the launcher into the
  // sandbox's start.json — the Worker does not need them.
  const profile: ProjectProfile = {
    ...DEFAULT_PROFILE,
    ...body.profile,
    id: body.projectId,
    repoUrl: body.repoUrl ?? DEFAULT_PROFILE.repoUrl,
    env: { ...body.profile?.env },
  };

  const id = env.SESSION_DO.newUniqueId();
  const stub = env.SESSION_DO.get(id);

  // The DO/sandbox runner needs a publicly reachable URL to dial back for
  // the WS bridge. Prefer the explicit WORKER_URL secret; fall back to the
  // request origin which is correct in production when the client hits the
  // deployed Worker directly.
  const controlBaseUrl = env.WORKER_URL?.replace(/\/$/, "") ?? url.origin;

  const session = await asRpc(stub).initSession(
    profile,
    body.taskDescription,
    controlBaseUrl,
    body.amendPrUrl,
    body.branchSuffix,
  );
  return new Response(JSON.stringify(session), { status: 201, headers: CORS_HEADERS });
}

async function handleSessionWsUpgrade(
  request: Request,
  env: CloudflareEnv,
  sessionId: string,
  wsType: string,
): Promise<Response> {
  const id = env.SESSION_DO.idFromString(sessionId);
  const stub = env.SESSION_DO.get(id);
  console.log(
    `[worker] WS upgrade: type=${wsType} sessionId=${sessionId.slice(0, 8)}... calling stub.fetch`,
  );
  const wsResp = await stub.fetch(request);
  console.log(`[worker] WS response status: ${wsResp.status} webSocket: ${!!wsResp.webSocket}`);
  return wsResp;
}

async function handleGetSessionState(env: CloudflareEnv, path: string): Promise<Response> {
  const sessionId = path.split("/")[2];
  let id: DurableObjectId;
  try {
    id = env.SESSION_DO.idFromString(sessionId);
  } catch {
    return new Response(JSON.stringify({ error: "session not found" }), {
      status: 404,
      headers: CORS_HEADERS,
    });
  }
  const stub = env.SESSION_DO.get(id);
  const data = await asRpc(stub).getState();
  // DO auto-instantiates empty; treat a missing session as 404.
  if (!data.session) {
    return new Response(JSON.stringify({ error: "session not found" }), {
      status: 404,
      headers: CORS_HEADERS,
    });
  }
  return new Response(JSON.stringify(data), { headers: CORS_HEADERS });
}

async function handleApprove(
  request: Request,
  env: CloudflareEnv,
  path: string,
): Promise<Response> {
  const sessionId = path.split("/")[2];
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(sessionId));
  const body = await request.json<{ requestId: string }>();
  const result = await asRpc(stub).approveRequest(body.requestId);
  return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
}

async function handleAbort(env: CloudflareEnv, path: string): Promise<Response> {
  const sessionId = path.split("/")[2];
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(sessionId));
  const result = await asRpc(stub).abortSession();
  return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
}

async function handlePrompt(request: Request, env: CloudflareEnv, path: string): Promise<Response> {
  const sessionId = path.split("/")[2];
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(sessionId));
  const { text } = await request.json<{ text: string }>();
  const result = await asRpc(stub).sendPrompt(text);
  const status = PROMPT_STATUS_BY_KIND[result.kind] ?? 200;
  return new Response(JSON.stringify(result.body), { status, headers: CORS_HEADERS });
}

async function handleRepoInstructions(
  request: Request,
  env: CloudflareEnv,
  path: string,
): Promise<Response> {
  const sessionId = path.split("/")[2];
  const body = await request.json<{
    source: "AGENTS.md" | "CLAUDE.md" | "CONVENTIONS.md";
    content: string;
  }>();
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(sessionId));
  const result = await asRpc(stub).setRepoInstructions(body);
  return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
}

async function handleCreatePr(env: CloudflareEnv, path: string): Promise<Response> {
  const sessionId = path.split("/")[2];
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(sessionId));
  const result = await asRpc(stub).createPR();
  return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
}

// --- /webhooks/github handler ----------------------------------------------
// Extracted from the fetch router so it can be lint-checked and tested in
// isolation. The body is verbatim from the inline branch; only the surrounding
// router scaffolding (path/method match, try/catch) is left in fetch.
async function handleGithubWebhook(request: Request, env: CloudflareEnv): Promise<Response> {
  const verifyResult = await verifyAndParseWebhook(request, env);
  if (verifyResult instanceof Response) return verifyResult;
  const parsed = verifyResult;

  const prIndex = asPrIndex(getPrIndexStub(env));
  const row = await prIndex.lookup(parsed.prKey);
  if (!row) {
    // Webhook arrived for a PR Hermes did not open (or whose row was
    // unregistered). Ack so GitHub doesn't retry.
    console.log(
      `[webhook] pull_request pr=${parsed.prKey} unknown to index ` +
        `(not a Hermes PR or already unregistered); acking`,
    );
    return new Response(JSON.stringify({ ok: true, kind: "unknown_pr" }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  }
  const novel = await prIndex.recordDelivery(parsed.prKey, parsed.deliveryId);
  if (!novel) {
    console.log(
      `[webhook] duplicate delivery=${parsed.deliveryId.slice(0, 8)} pr=${parsed.prKey}; ack`,
    );
    return new Response(JSON.stringify({ ok: true, kind: "duplicate" }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  }

  if (parsed.kind === "pull_request") {
    return handlePullRequestEvent(parsed, row, env, prIndex);
  }
  return handleAmendTrigger(parsed, row, env, prIndex);
}

/** Verify HMAC + parse the webhook body. On success returns the parsed event
 *  (never `kind: "ignored"` — those are short-circuited with a 200 ack here).
 *  On any failure / ignored case, returns the Response to send back to GitHub. */
async function verifyAndParseWebhook(
  request: Request,
  env: CloudflareEnv,
): Promise<Exclude<ReturnType<typeof parseGithubWebhook>, null | { kind: "ignored" }> | Response> {
  const rawBody = await request.text();
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: "webhook secret not configured" }), {
      status: 503,
      headers: CORS_HEADERS,
    });
  }
  const verified = await verifyGithubHmac({
    rawBody,
    signatureHeader: request.headers.get("x-hub-signature-256"),
    secret: env.GITHUB_WEBHOOK_SECRET,
  });
  if (!verified) {
    return new Response(JSON.stringify({ error: "invalid signature" }), {
      status: 401,
      headers: CORS_HEADERS,
    });
  }
  const parsed = parseGithubWebhook(
    request.headers.get("x-github-event"),
    request.headers.get("x-github-delivery"),
    rawBody,
  );
  if (!parsed) {
    return new Response(JSON.stringify({ error: "unparseable webhook payload" }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }
  if (parsed.kind === "ignored") {
    console.log(
      `[webhook] ignored event=${request.headers.get("x-github-event")} ` +
        `delivery=${parsed.deliveryId.slice(0, 8)} reason=${parsed.reason}`,
    );
    return new Response(JSON.stringify({ ok: true, kind: "ignored", reason: parsed.reason }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  }
  return parsed;
}

type ParsedNonIgnored = Exclude<
  NonNullable<ReturnType<typeof parseGithubWebhook>>,
  { kind: "ignored" }
>;
type ParsedPullRequest = Extract<ParsedNonIgnored, { kind: "pull_request" }>;
type AmendTriggerParsed = Exclude<ParsedNonIgnored, { kind: "pull_request" }>;
type PrIndexStub = ReturnType<typeof asPrIndex>;
type PrIndexRow = NonNullable<Awaited<ReturnType<PrIndexStub["lookup"]>>>;

async function handlePullRequestEvent(
  parsed: ParsedPullRequest,
  row: PrIndexRow,
  env: CloudflareEnv,
  prIndex: PrIndexStub,
): Promise<Response> {
  // Lifecycle actions we care about: `closed` (terminal — archive
  // session or just mark the row closed) and `reopened` (revive the
  // index row so amend re-provision works again). GitHub also fires
  // `opened`, `edited`, `synchronize`, `ready_for_review`, etc. for
  // the `pull_request` event — none of those map onto a Hermes
  // lifecycle transition, so we ack the delivery (the dedup ring
  // already recorded it) and skip the SESSION_DO dispatch. Without
  // this guard, every `synchronize` from the runner's own
  // `git push` would emit a spurious `pr.closed` (merged=false).
  let archived = false;
  if (parsed.action === "reopened") {
    // Closed-unmerged PRs keep their index row with status="closed"
    // so a subsequent reopen lands back on the same parent session.
    // Flip the status back to "open" so send_followup_prompt and
    // the auto-amend webhook dispatcher stop rejecting on
    // status!=="open".
    await prIndex.markStatus(parsed.prKey, "open");
  } else if (parsed.action === "closed") {
    await prIndex.markStatus(parsed.prKey, parsed.merged ? "merged" : "closed");
    try {
      const sessId = env.SESSION_DO.idFromString(row.sessionId);
      const stub = env.SESSION_DO.get(sessId);
      const res = await asRpc(stub).ingestPrLifecycleEvent({
        merged: parsed.merged,
        prUrl: parsed.prUrl,
        deliveryId: parsed.deliveryId,
        senderLogin: parsed.senderLogin,
      });
      archived = res.archived;
    } catch (err) {
      console.error(
        `[webhook] SESSION_DO.ingestPrLifecycleEvent failed for ${row.sessionId}: ` +
          `${(err as Error).message}`,
      );
      // Don't 5xx — we already updated the index row and dedup'd the
      // delivery. GitHub retrying won't fix a missing/corrupt DO.
    }

    // Drop the row once the PR is merged so the index doesn't grow
    // unbounded. Closed-unmerged stays so future re-open events
    // still land on the right session.
    if (parsed.merged) {
      await prIndex.unregister(parsed.prKey);
    }
  }

  console.log(
    `[webhook] pull_request pr=${parsed.prKey} action=${parsed.action} ` +
      `merged=${parsed.merged} session=${row.sessionId.slice(0, 8)} archived=${archived}`,
  );
  return new Response(
    JSON.stringify({
      ok: true,
      kind: "pull_request",
      archived,
      sessionId: row.sessionId,
    }),
    { status: 200, headers: CORS_HEADERS },
  );
}

// pull_request_review.changes_requested + check_run_failed:
// try to claim the single-flight amend slot. If claimed, POST
// /sessions on the launcher with parentSessionId + a built
// taskDescription. The spawned session releases the slot on
// terminal (see SessionDurableObject.transition).
async function handleAmendTrigger(
  parsed: AmendTriggerParsed,
  row: PrIndexRow,
  env: CloudflareEnv,
  prIndex: PrIndexStub,
): Promise<Response> {
  const launcherUrl = env.LAUNCHER_URL;
  if (!launcherUrl) {
    console.warn(`[webhook] ${parsed.kind} pr=${parsed.prKey}: skipped (LAUNCHER_URL unset)`);
    await appendAutofixSkip(env, row, parsed, "launcher_not_configured");
    return amendSkipResponse(parsed.kind, "launcher_not_configured");
  }

  const selfSkip = detectSelfTrigger(parsed, row);
  if (selfSkip) {
    console.log(`[webhook] self-${selfSkip} on pr=${parsed.prKey}; skip`);
    await appendAutofixSkip(env, row, parsed, `self_${selfSkip}`);
    return amendSkipResponse(parsed.kind, `self_${selfSkip}`);
  }

  // Try-claim with the cap from env (default 3). Claim under the parent
  // session id as a placeholder — we do not know the spawned session id
  // until the launcher returns. After /sessions succeeds we call
  // transferAmendSlot(newSessionId) to hand the slot to the spawned
  // session; its own transition() hook releases the slot on terminal
  // (matched by spawned id).
  const cap = Number(env.AUTOFIX_CAP_PER_PR ?? "3") || 3;
  const claim = await prIndex.tryClaimAmendSlot(parsed.prKey, parsed.headSha, row.sessionId, cap);
  if (!claim.ok) {
    console.log(`[webhook] ${parsed.kind} pr=${parsed.prKey} skip reason=${claim.reason}`);
    await appendAutofixSkip(env, row, parsed, claim.reason);
    return amendSkipResponse(parsed.kind, claim.reason);
  }

  const taskDescription = buildAmendTaskDescription(parsed);
  const dispatch = await dispatchToLauncher(launcherUrl, env, row, parsed, taskDescription);
  if (dispatch.kind === "failed") {
    await prIndex.rollbackAmendClaim(parsed.prKey, row.sessionId);
    if (dispatch.reason !== "launcher_unreachable") {
      await appendAutofixSkip(env, row, parsed, dispatch.reason);
    }
    return amendSkipResponse(parsed.kind, dispatch.reason);
  }
  const newSessionId = dispatch.sessionId;
  // Hand the inflight slot over to the spawned session; its own
  // transition() hook releases it on terminal.
  await prIndex.transferAmendSlot(parsed.prKey, newSessionId);

  // Record the trigger on the parent session.
  try {
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(row.sessionId));
    await asRpc(stub).appendAutofixEvent({
      triggered: true,
      trigger: parsed.kind,
      deliveryId: parsed.deliveryId,
      headSha: parsed.headSha,
      newSessionId,
      ...amendTriggerFields(parsed),
    });
  } catch (err) {
    console.error(`[webhook] appendAutofixEvent failed: ${(err as Error).message}`);
  }

  console.log(
    `[webhook] ${parsed.kind} pr=${parsed.prKey} spawned newSession=${newSessionId.slice(0, 8)} autofixCount=${claim.autofixCount}`,
  );
  return new Response(
    JSON.stringify({
      ok: true,
      kind: parsed.kind,
      dispatched: true,
      newSessionId,
      autofixCount: claim.autofixCount,
    }),
    { status: 200, headers: CORS_HEADERS },
  );
}

// --- Webhook helpers -------------------------------------------------------

function amendTriggerFields(
  parsed: AmendTriggerParsed,
): { reviewerLogin: string } | { checkName: string; detailsUrl: string } {
  if (parsed.kind === "review_changes_requested") {
    return { reviewerLogin: parsed.reviewerLogin };
  }
  return { checkName: parsed.checkName, detailsUrl: parsed.detailsUrl };
}

function amendSkipResponse(kind: AmendTriggerParsed["kind"], reason: string): Response {
  return new Response(JSON.stringify({ ok: true, kind, dispatched: false, reason }), {
    status: 200,
    headers: CORS_HEADERS,
  });
}

/** Self-trigger guards. We only auto-amend when the trigger comes from a
 *  party other than the operator; otherwise the amend's own activity loops.
 *  Returns the short reason tag ("review" / "check_run") or null. */
function detectSelfTrigger(
  parsed: AmendTriggerParsed,
  row: PrIndexRow,
): "review" | "check_run" | null {
  if (parsed.kind === "review_changes_requested" && parsed.reviewerLogin === row.ownerLogin) {
    return "review";
  }
  // check_run normally comes from github-actions[bot]. If the workflow ran
  // under a User-typed token (e.g. the operator's PAT), it would re-fire on
  // every amend push and burn AUTOFIX_CAP_PER_PR within seconds. Reject only
  // when sender is a User AND matches the operator (gating purely on
  // senderType would break legit bot setups other than github-actions[bot]).
  if (
    parsed.kind === "check_run_failed" &&
    parsed.senderType === "User" &&
    parsed.senderLogin === row.ownerLogin
  ) {
    return "check_run";
  }
  return null;
}

async function appendAutofixSkip(
  env: CloudflareEnv,
  row: PrIndexRow,
  parsed: AmendTriggerParsed,
  skipReason: string,
): Promise<void> {
  try {
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(row.sessionId));
    await asRpc(stub).appendAutofixEvent({
      triggered: false,
      trigger: parsed.kind,
      deliveryId: parsed.deliveryId,
      headSha: parsed.headSha,
      skipReason,
      ...amendTriggerFields(parsed),
    });
  } catch (err) {
    console.error(`[webhook] appendAutofixEvent (skip) failed: ${(err as Error).message}`);
  }
}

function buildAmendTaskDescription(parsed: AmendTriggerParsed): string {
  const prNumber = parsed.prKey.split("#")[1];
  if (parsed.kind === "review_changes_requested") {
    const reviewer = parsed.reviewerLogin || "(unknown)";
    const body = parsed.reviewBody?.trim() || "(no body — reviewer used inline comments only)";
    return (
      `PR reviewer @${reviewer} requested changes on PR #${prNumber} (${parsed.prUrl}).\n\n` +
      `Review feedback:\n\n${body}\n\n` +
      `Apply the requested changes in a single commit. Do not open a new PR.`
    );
  }
  return (
    `CI check "${parsed.checkName}" failed on PR #${prNumber} (${parsed.prUrl}).\n\n` +
    `Logs / details: ${parsed.detailsUrl}\n\n` +
    `Fetch the failure logs, identify the root cause, and fix it in a single commit. ` +
    `Do not open a new PR.`
  );
}

type DispatchResult = { kind: "ok"; sessionId: string } | { kind: "failed"; reason: string };

async function dispatchToLauncher(
  launcherUrl: string,
  env: CloudflareEnv,
  row: PrIndexRow,
  parsed: AmendTriggerParsed,
  taskDescription: string,
): Promise<DispatchResult> {
  const amendTrigger =
    parsed.kind === "review_changes_requested"
      ? {
          kind: "review_changes_requested",
          reviewerLogin: parsed.reviewerLogin,
          reviewBody: (parsed.reviewBody || "").slice(0, 4096),
        }
      : {
          kind: "ci_failure",
          checkName: parsed.checkName,
          detailsUrl: parsed.detailsUrl,
          conclusion: (parsed as { conclusion?: string }).conclusion ?? "failure",
        };
  let r: Response;
  try {
    r = await fetch(`${launcherUrl}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hermes-launcher-secret": env.LAUNCHER_SHARED_SECRET ?? "",
      },
      body: JSON.stringify({
        parentSessionId: row.sessionId,
        taskDescription,
        // A5: structured trigger metadata so the runner can pick a
        // preamble tailored to the failure class. Backwards-compatible:
        // launchers on the old shape simply ignore these fields.
        amendTrigger,
      }),
    });
  } catch (err) {
    console.error(
      `[webhook] launcher /sessions error: ${(err as Error).message}; rolling back claim`,
    );
    return { kind: "failed", reason: "launcher_unreachable" };
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.error(
      `[webhook] launcher /sessions ${r.status}: ${txt.slice(0, 200)}; rolling back claim`,
    );
    return { kind: "failed", reason: `launcher_${r.status}` };
  }
  const data = (await r.json()) as { sessionId?: string };
  if (!data.sessionId) {
    // 2xx without a sessionId means we cannot transfer the slot to the
    // spawned session. Without transfer, the slot stays claimed under
    // the parent id; releaseAmendSlot from the spawned DO is a no-op
    // (id mismatch) and the PR is blocked from auto-amend until the
    // 10-min INFLIGHT_TTL_MS elapses. Treat the same as launcher failure.
    console.error(
      `[webhook] launcher /sessions returned ${r.status} without sessionId; rolling back claim`,
    );
    return { kind: "failed", reason: "launcher_no_session_id" };
  }
  return { kind: "ok", sessionId: data.sessionId };
}
