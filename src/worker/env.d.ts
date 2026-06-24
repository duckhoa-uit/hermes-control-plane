// Cloudflare bindings type
interface CloudflareEnv {
  SESSION_DO: DurableObjectNamespace;
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  E2B_TEMPLATE: string;
  E2B_API_KEY?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  MAX_SESSION_RUNTIME_MS: number;
  HEARTBEAT_TIMEOUT_MS: number;
}
