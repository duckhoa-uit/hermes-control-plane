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
}
