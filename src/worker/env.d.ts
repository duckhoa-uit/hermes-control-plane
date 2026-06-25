// Cloudflare bindings type
interface CloudflareEnv {
  SESSION_DO: DurableObjectNamespace;
  E2B_TEMPLATE: string;
  E2B_API_KEY?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  MAX_SESSION_RUNTIME_MS: number;
  HEARTBEAT_TIMEOUT_MS: number;
  // Hobby-tier concurrency guard (M3). See docs/ROADMAP.md section 8.
  MAX_CONCURRENT_SESSIONS: number;
  // Public base URL the sandbox runner uses to dial back over WS.
  // Locally: an ngrok URL pointing at wrangler dev. Production: deployed Worker URL.
  PUBLIC_BASE_URL?: string;
  // M5: launcher sidecar URL (so DO can POST /resume to thaw a paused
  // sandbox). Optional — when unset, DO returns 409 with recoverable:false
  // on follow-up to a disconnected runner (pre-M5 behaviour).
  HERMES_LAUNCHER_URL?: string;
  // Zai (z.ai) LLM provider - OpenAI-compatible
  ZAI_API_KEY?: string;
  ZAI_MODEL?: string;
}
