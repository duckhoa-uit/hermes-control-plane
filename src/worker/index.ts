// ============================================================
// Hermes Control Plane - Worker API
// Routes: create session, get session, WS stream, approve/deny, abort, create PR
// ============================================================

import { SessionDurableObject } from "./session-do";
import { PrIndexDurableObject } from "./pr-index-do";
import { verifyGithubHmac, parseGithubWebhook } from "./github-webhook";
import { getPrIndexStub } from "./pr-index-do";
import type { PromptResult } from "./session-do";
import type {
  ProjectProfile,
  Session,
  HermesEvent,
  SessionArtifacts,
} from "../core/types";

// RPC contract surface — explicit interface so TS does not have to walk the
// full DO class (whose return shapes contain Record<string, unknown> which
// fails CF's Rpc.Serializable<T> check). The DO class implements the same
// signatures.
interface SessionDORpc {
  initSession(
    profile: ProjectProfile,
    taskDescription: string,
    controlBaseUrl: string,
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

    try {
      // Debug: log all requests
      console.log(`[debug] ${request.method} ${path} Upgrade=${request.headers.get("Upgrade")}`);

      // ---- Health ----
      if (path === "/health" || path === "/") {
        return new Response(
          JSON.stringify({ status: "ok", service: "hermes-control-plane" }),
          { headers: CORS_HEADERS },
        );
      }

      // ---- PR index lookup ----
      // GET /pr-index?key=<owner/repo#N>
      // Returns the PR index row for a given prKey, or 404 if missing.
      // Used by the launcher to decide whether send_followup_prompt should
      // re-provision in amend mode against an open PR.
      if (path === "/pr-index" && request.method === "GET") {
        const key = url.searchParams.get("key");
        if (!key) {
          return new Response(
            JSON.stringify({ error: "missing ?key=" }),
            { status: 400, headers: CORS_HEADERS },
          );
        }
        const stub = getPrIndexStub(env);
        const row = await asPrIndex(stub).lookup(key);
        if (!row) {
          return new Response(
            JSON.stringify({ error: "not found", key }),
            { status: 404, headers: CORS_HEADERS },
          );
        }
        return new Response(JSON.stringify({ row }), { headers: CORS_HEADERS });
      }

      // ---- GitHub webhook (HMAC-verified) ----
      // POST /webhooks/github
      // Headers: X-Hub-Signature-256, X-GitHub-Event, X-GitHub-Delivery
      // Body: raw JSON payload (we must hash the bytes GitHub signed).
      //
      // Scope is intentionally narrow: we only act on `pull_request`
      // events (merged/closed -> archive the parent session). Follow-up
      // prompts are gateway-driven; we do not consume mentions or
      // comments from here.
      if (path === "/webhooks/github" && request.method === "POST") {
        const rawBody = await request.text();
        if (!env.GITHUB_WEBHOOK_SECRET) {
          // Fail closed on misconfig.
          return new Response(
            JSON.stringify({ error: "webhook secret not configured" }),
            { status: 503, headers: CORS_HEADERS },
          );
        }
        const verified = await verifyGithubHmac({
          rawBody,
          signatureHeader: request.headers.get("x-hub-signature-256"),
          secret: env.GITHUB_WEBHOOK_SECRET,
        });
        if (!verified) {
          return new Response(
            JSON.stringify({ error: "invalid signature" }),
            { status: 401, headers: CORS_HEADERS },
          );
        }
        const parsed = parseGithubWebhook(
          request.headers.get("x-github-event"),
          request.headers.get("x-github-delivery"),
          rawBody,
        );
        if (!parsed) {
          return new Response(
            JSON.stringify({ error: "unparseable webhook payload" }),
            { status: 400, headers: CORS_HEADERS },
          );
        }
        if (parsed.kind === "ignored") {
          // ping or any event we don't act on. Always 200 so GitHub
          // marks the delivery successful and doesn't retry.
          console.log(
            `[webhook] ignored event=${request.headers.get("x-github-event")} ` +
            `delivery=${parsed.deliveryId.slice(0, 8)} reason=${parsed.reason}`,
          );
          return new Response(
            JSON.stringify({ ok: true, kind: "ignored", reason: parsed.reason }),
            { status: 200, headers: CORS_HEADERS },
          );
        }

        // From here on we need the PR index for all kinds. Compute
        // once; each kind branches below for its own dispatch.
        const prIndex = asPrIndex(getPrIndexStub(env));
        const row = await prIndex.lookup(parsed.prKey);
        if (!row) {
          // Webhook arrived for a PR Hermes did not open (or whose row
          // was unregistered). Ack so GitHub doesn't retry.
          console.log(
            `[webhook] pull_request pr=${parsed.prKey} unknown to index ` +
            `(not a Hermes PR or already unregistered); acking`,
          );
          return new Response(
            JSON.stringify({ ok: true, kind: "unknown_pr" }),
            { status: 200, headers: CORS_HEADERS },
          );
        }
        const novel = await prIndex.recordDelivery(parsed.prKey, parsed.deliveryId);
        if (!novel) {
          console.log(
            `[webhook] duplicate delivery=${parsed.deliveryId.slice(0, 8)} pr=${parsed.prKey}; ack`,
          );
          return new Response(
            JSON.stringify({ ok: true, kind: "duplicate" }),
            { status: 200, headers: CORS_HEADERS },
          );
        }

        // Branch on the parsed kind.
        if (parsed.kind === "pull_request") {
          // Lifecycle actions we care about. GitHub also fires `opened`,
          // `reopened`, `edited`, `synchronize`, `ready_for_review`, etc.
          // for the `pull_request` event — none of those map onto a Hermes
          // lifecycle transition, so we ack the delivery (the dedup ring
          // already recorded it) and skip the SESSION_DO dispatch. Without
          // this guard, every `synchronize` from the runner's own
          // `git push` would emit a spurious `pr.closed` (merged=false).
          let archived = false;
          if (parsed.action === "closed") {
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
        const launcherUrl = env.CONTROL_PLANE_LAUNCHER_URL;
        if (!launcherUrl) {
          console.warn(
            `[webhook] ${parsed.kind} pr=${parsed.prKey}: skipped (CONTROL_PLANE_LAUNCHER_URL unset)`,
          );
          try {
            const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(row.sessionId));
            await asRpc(stub).appendAutofixEvent({
              triggered: false,
              trigger: parsed.kind,
              deliveryId: parsed.deliveryId,
              headSha: parsed.headSha,
              skipReason: "launcher_not_configured",
              ...(parsed.kind === "review_changes_requested"
                ? { reviewerLogin: parsed.reviewerLogin }
                : { checkName: parsed.checkName, detailsUrl: parsed.detailsUrl }),
            });
          } catch (err) {
            console.error(`[webhook] appendAutofixEvent (skip) failed: ${(err as Error).message}`);
          }
          return new Response(
            JSON.stringify({ ok: true, kind: parsed.kind, dispatched: false, reason: "launcher_not_configured" }),
            { status: 200, headers: CORS_HEADERS },
          );
        }

        // Self-trigger guard: refuse if the sender IS the operator that
        // would be authoring the amend (this is the bot itself pushing,
        // and the resulting check_run.failed would loop). The check_run
        // event has sender=github-actions[bot]; we let those through.
        // For review_changes_requested we reject when reviewerLogin OR
        // senderLogin equals the operator (rare — operator self-review).
        // The operator login is GITHUB_USER_LOGIN — fetched per-session
        // by the launcher; we approximate by trusting row.ownerLogin
        // (set when the parent session created the PR).
        if (parsed.kind === "review_changes_requested" && parsed.reviewerLogin === row.ownerLogin) {
          console.log(`[webhook] self-review on pr=${parsed.prKey}; skip`);
          try {
            const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(row.sessionId));
            await asRpc(stub).appendAutofixEvent({
              triggered: false,
              trigger: parsed.kind,
              deliveryId: parsed.deliveryId,
              headSha: parsed.headSha,
              skipReason: "self_review",
              reviewerLogin: parsed.reviewerLogin,
            });
          } catch {}
          return new Response(
            JSON.stringify({ ok: true, kind: parsed.kind, dispatched: false, reason: "self_review" }),
            { status: 200, headers: CORS_HEADERS },
          );
        }

        // Try-claim with the cap from env (default 3).
        const cap = Number(env.HERMES_AUTOFIX_CAP ?? "3") || 3;
        // We synthesize the new session id LATER (from the launcher
        // response). For the slot-claim we use a placeholder; release uses
        // the same placeholder, then the spawned session releases itself
        // via the inflightSessionId match. Actually that mismatch would
        // block release. Better: pass the parent session id as the
        // claimant; the spawned session releases via its OWN id which
        // does not match → release no-op. Then the slot only frees when
        // the spawned session reaches terminal — wait, that still does
        // not match. Resolve by passing a known marker the spawned
        // session can also use: parent's sessionId. The transition hook
        // calls releaseAmendSlot(prKey, this.session.id) which would
        // mismatch. Fix: claim with the spawned session id, but we don't
        // have it yet. Two-step: claim with parent id, then re-claim
        // with new id atomically? Too complex. Easier: don't gate
        // release by id match (the transition hook is the only caller
        // for amend sessions; spam-release from non-amend sessions is
        // harmless because PR_INDEX_DO has no row for unknown PRs).
        const claim = await prIndex.tryClaimAmendSlot(
          parsed.prKey,
          parsed.headSha,
          // Use parent sessionId as placeholder; the spawned session
          // releases via its own id which is intentionally different
          // (see comment in releaseAmendSlot below).
          row.sessionId,
          cap,
        );
        if (!claim.ok) {
          console.log(
            `[webhook] ${parsed.kind} pr=${parsed.prKey} skip reason=${claim.reason}`,
          );
          try {
            const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(row.sessionId));
            await asRpc(stub).appendAutofixEvent({
              triggered: false,
              trigger: parsed.kind,
              deliveryId: parsed.deliveryId,
              headSha: parsed.headSha,
              skipReason: claim.reason,
              ...(parsed.kind === "review_changes_requested"
                ? { reviewerLogin: parsed.reviewerLogin }
                : { checkName: parsed.checkName, detailsUrl: parsed.detailsUrl }),
            });
          } catch {}
          return new Response(
            JSON.stringify({ ok: true, kind: parsed.kind, dispatched: false, reason: claim.reason }),
            { status: 200, headers: CORS_HEADERS },
          );
        }

        // Build the task description from the trigger.
        let taskDescription: string;
        if (parsed.kind === "review_changes_requested") {
          const reviewer = parsed.reviewerLogin || "(unknown)";
          const body = parsed.reviewBody?.trim() || "(no body — reviewer used inline comments only)";
          taskDescription =
            `PR reviewer @${reviewer} requested changes on PR #${parsed.prKey.split("#")[1]} ` +
            `(${parsed.prUrl}).

Review feedback:

${body}

` +
            `Apply the requested changes in a single commit. Do not open a new PR.`;
        } else {
          taskDescription =
            `CI check "${parsed.checkName}" failed on PR #${parsed.prKey.split("#")[1]} ` +
            `(${parsed.prUrl}).

Logs / details: ${parsed.detailsUrl}

` +
            `Fetch the failure logs, identify the root cause, and fix it in a single commit. ` +
            `Do not open a new PR.`;
        }

        // POST /sessions on the launcher with parentSessionId.
        let newSessionId: string | null = null;
        try {
          const r = await fetch(`${launcherUrl}/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ parentSessionId: row.sessionId, taskDescription }),
          });
          if (!r.ok) {
            const txt = await r.text().catch(() => "");
            console.error(
              `[webhook] launcher /sessions ${r.status}: ${txt.slice(0, 200)}; releasing slot`,
            );
            await prIndex.releaseAmendSlot(parsed.prKey, row.sessionId);
            try {
              const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(row.sessionId));
              await asRpc(stub).appendAutofixEvent({
                triggered: false,
                trigger: parsed.kind,
                deliveryId: parsed.deliveryId,
                headSha: parsed.headSha,
                skipReason: `launcher_${r.status}`,
              });
            } catch {}
            return new Response(
              JSON.stringify({ ok: true, kind: parsed.kind, dispatched: false, reason: `launcher_${r.status}` }),
              { status: 200, headers: CORS_HEADERS },
            );
          }
          const data = (await r.json()) as { sessionId?: string };
          newSessionId = data.sessionId ?? null;
          if (newSessionId) {
            // Hand the inflight slot over to the spawned session; its own
            // transition() hook will release it on terminal.
            await prIndex.transferAmendSlot(parsed.prKey, newSessionId);
          }
        } catch (err) {
          console.error(
            `[webhook] launcher /sessions error: ${(err as Error).message}; releasing slot`,
          );
          await prIndex.releaseAmendSlot(parsed.prKey, row.sessionId);
          return new Response(
            JSON.stringify({ ok: true, kind: parsed.kind, dispatched: false, reason: "launcher_unreachable" }),
            { status: 200, headers: CORS_HEADERS },
          );
        }

        // Record the trigger on the parent session.
        try {
          const stub = env.SESSION_DO.get(env.SESSION_DO.idFromString(row.sessionId));
          await asRpc(stub).appendAutofixEvent({
            triggered: true,
            trigger: parsed.kind,
            deliveryId: parsed.deliveryId,
            headSha: parsed.headSha,
            newSessionId: newSessionId ?? undefined,
            ...(parsed.kind === "review_changes_requested"
              ? { reviewerLogin: parsed.reviewerLogin }
              : { checkName: parsed.checkName, detailsUrl: parsed.detailsUrl }),
          });
        } catch (err) {
          console.error(`[webhook] appendAutofixEvent failed: ${(err as Error).message}`);
        }

        console.log(
          `[webhook] ${parsed.kind} pr=${parsed.prKey} spawned newSession=${newSessionId?.slice(0, 8)} autofixCount=${claim.autofixCount}`,
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

      // ---- Create session ----
      // POST /sessions
      // Body: { projectId, taskDescription, repoUrl?, profile? }
      if (path === "/sessions" && request.method === "POST") {
        const body = await request.json<{
          projectId: string;
          taskDescription: string;
          repoUrl?: string;
          profile?: Partial<ProjectProfile>;
        }>();

        // Build profile. LLM credentials (ZAI_API_KEY etc.) and any other
        // per-session env vars are injected host-side by the launcher into
        // the sandbox's start.json (src/launcher/provision.ts) — the Worker
        // does not need them.
        const profile: ProjectProfile = {
          ...DEFAULT_PROFILE,
          ...body.profile,
          id: body.projectId,
          repoUrl: body.repoUrl ?? DEFAULT_PROFILE.repoUrl,
          env: {
            ...(body.profile?.env ?? {}),
          },
        };

        // Create DO stub
        const id = env.SESSION_DO.newUniqueId();
        const stub = env.SESSION_DO.get(id);

        // The DO/sandbox runner needs a publicly reachable URL to dial back
        // for the WS bridge. Prefer the explicit PUBLIC_BASE_URL secret (set
        // to e.g. an ngrok URL locally, or the deployed Worker URL in prod);
        // fall back to the request origin which is correct in production
        // when the client hits the deployed Worker directly.
        const controlBaseUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? url.origin;

        const session = await asRpc(stub).initSession(profile, body.taskDescription, controlBaseUrl);

        return new Response(JSON.stringify(session), {
          status: 201,
          headers: CORS_HEADERS,
        });
      }

      // ---- WebSocket: any /sessions/:id/ws upgrade ----
      // Client: GET /sessions/:id/stream (role=client)
      // Runner: GET /sessions/:id/runner?token=xxx (role=runner)
      const isWSUpgrade = request.headers.get("Upgrade") === "websocket";
      const wsMatch = path.match(/^\/sessions\/([^/]+)\/(stream|runner)$/);

      if (isWSUpgrade && wsMatch) {
        const sessionId = wsMatch[1];
        const wsType = wsMatch[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);

        console.log(`[worker] WS upgrade: type=${wsType} sessionId=${sessionId.slice(0,8)}... calling stub.fetch`);
        const wsResp = await stub.fetch(request);
        console.log(`[worker] WS response status: ${wsResp.status} webSocket: ${!!wsResp.webSocket}`);
        return wsResp;
      }

      // ---- Get session state ----
      // GET /sessions/:id
      if (path.startsWith("/sessions/") && request.method === "GET") {
        const sessionId = path.split("/")[2];
        let id: DurableObjectId;
        try {
          id = env.SESSION_DO.idFromString(sessionId);
        } catch {
          return new Response(
            JSON.stringify({ error: "session not found" }),
            { status: 404, headers: CORS_HEADERS },
          );
        }
        const stub = env.SESSION_DO.get(id);

        const data = await asRpc(stub).getState();
        // DO auto-instantiates empty; treat a missing session as 404.
        if (!data.session) {
          return new Response(
            JSON.stringify({ error: "session not found" }),
            { status: 404, headers: CORS_HEADERS },
          );
        }

        return new Response(JSON.stringify(data), { headers: CORS_HEADERS });
      }

      // ---- Approve action ----
      // POST /sessions/:id/approve  body: { requestId }
      if (path.endsWith("/approve") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);
        const body = await request.json<{ requestId: string }>();
        const result = await asRpc(stub).approveRequest(body.requestId);
        return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
      }

      // ---- Abort session ----
      // POST /sessions/:id/abort
      if (path.endsWith("/abort") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);
        const result = await asRpc(stub).abortSession();
        return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
      }

      // ---- Follow-up prompt (M2) ----
      // POST /sessions/:id/prompt   body: { text }
      if (path.endsWith("/prompt") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);
        const { text } = await request.json<{ text: string }>();
        const result = await asRpc(stub).sendPrompt(text);
        const status = PROMPT_STATUS_BY_KIND[result.kind] ?? 200;
        return new Response(JSON.stringify(result.body), {
          status,
          headers: CORS_HEADERS,
        });
      }

      // ---- Create PR ----
      // POST /sessions/:id/create-pr
      if (path.endsWith("/create-pr") && request.method === "POST") {
        const sessionId = path.split("/")[2];
        const id = env.SESSION_DO.idFromString(sessionId);
        const stub = env.SESSION_DO.get(id);
        const result = await asRpc(stub).createPR();
        return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: CORS_HEADERS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return new Response(
        JSON.stringify({ error: message }),
        { status: 500, headers: CORS_HEADERS },
      );
    }
  },
};
