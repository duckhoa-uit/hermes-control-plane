// Cloudflare bindings type
interface CloudflareEnv {
  SESSION_DO: DurableObjectNamespace;
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
  HERMES_LAUNCHER_URL?: string;
}
