// Cloudflare bindings type.
// Mirrors `wrangler types` output shape; the generic on
// DurableObjectNamespace<T> makes stub RPC calls type-safe.
interface CloudflareEnv {
  SESSION_DO: DurableObjectNamespace<import("./session-do").SessionDurableObject>;
  // PR index DO — singleton, idFromName("global"). Maps `owner/repo#N`
  // → sessionId for webhook lookups and follow-up auto-amend.
  PR_INDEX_DO: DurableObjectNamespace<import("./pr-index-do").PrIndexDurableObject>;
  E2B_TEMPLATE: string;
  // Gates session creation. Worker doesn't call E2B directly (workerd kills
  // the SDK); it just refuses to provision when this is unset so the host
  // launcher (scripts/launch-session.ts) is guaranteed to have a key.
  E2B_API_KEY?: string;
  // Public base URL the sandbox runner uses to dial back over WS.
  // Locally: an ngrok URL pointing at wrangler dev. Production: deployed Worker URL.
  PUBLIC_BASE_URL?: string;
  // M5: launcher sidecar URL (so DO can POST /resume to thaw a paused
  // sandbox). Optional — when unset, DO returns 409 with recoverable:false
  // on follow-up to a disconnected runner (pre-M5 behaviour).
  CONTROL_PLANE_LAUNCHER_URL?: string;
  // HMAC secret used to verify POST /webhooks/github deliveries. Set with
  // `wrangler secret put GITHUB_WEBHOOK_SECRET`; matches the "Secret"
  // field in the GitHub webhook settings.
  GITHUB_WEBHOOK_SECRET?: string;
  // Maximum number of auto-amend sessions that can spawn against a single
  // open PR before tryClaimAmendSlot starts rejecting with cap_exceeded.
  // Defaults to 3 in the handler.
  HERMES_AUTOFIX_CAP?: string;
  // Shared secret authenticating launcher → Worker calls on routes that
  // would otherwise leak session ids to anonymous callers (notably
  // GET /pr-index, which maps a public PR URL → sessionId). Set with
  // `wrangler secret put HERMES_LAUNCHER_SECRET` and mirror it in the
  // launcher's HERMES_LAUNCHER_SECRET env. When unset, the Worker fails
  // closed (503) on the guarded routes.
  HERMES_LAUNCHER_SECRET?: string;
  // Phase 6 / publish-via-launcher rollout flag (see
  // docs/PLAN-GIT-AUTHORITY-REFACTOR.md). When "true", the DO routes
  // PR publication via the launcher's POST /sessions/:id/publish-pr
  // endpoint instead of asking the runner to push + open the PR
  // itself. PR #B (publish-via-launcher) reads this; PR #A only
}
