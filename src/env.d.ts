interface Env {
  // Application DO bindings (from wrangler.jsonc)
  Sandbox: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  PR_INDEX_DO: DurableObjectNamespace<import("./do/pr-index-do").PrIndexDurableObject>;

  // Flue-generated DO bindings
  FLUE_HERMES_AGENT: DurableObjectNamespace;
  FLUE_REGISTRY: DurableObjectNamespace;

  // Cloudflare bindings
  AI: import("agents").Ai;

  // Secrets and vars
  GITHUB_WRITE_TOKEN: string;
  GITHUB_READ_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_USER_LOGIN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  LLM_MODEL: string;
  POSTHOG_HOST: string;
  POSTHOG_PROJECT_TOKEN: string;
  AUTOFIX_CAP_PER_PR: string;
  MAX_CONCURRENT_SESSIONS: string;
  AUTO_CREATE_PR: string;
  ZAI_API_KEY: string;
  WORKER_URL: string;
}
