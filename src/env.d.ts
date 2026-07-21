interface Env {
  // Application DO bindings (from wrangler.jsonc)
  Sandbox: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  PR_INDEX_DO: DurableObjectNamespace<import("./do/pr-index-do.js").PrIndexDurableObject>;
  APPROVAL_DO: DurableObjectNamespace<import("./do/approval-do.js").ApprovalDurableObject>;
  CONTROL_PLAN_TASK_DO: DurableObjectNamespace<
    import("./do/coding-task-do.js").ControlPlanTaskDurableObject
  >;
  CONTROL_PLAN_ADMISSION_DO: DurableObjectNamespace<
    import("./do/admission-do.js").ControlPlanAdmissionDurableObject
  >;

  // Flue-generated DO bindings
  FLUE_CONTROL_PLAN_AGENT: DurableObjectNamespace;
  FLUE_REGISTRY: DurableObjectNamespace;

  // Cloudflare bindings
  AI: import("agents").Ai;

  // Secrets and vars
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET: string;
  CONTROL_PLAN_REPLAY_SECRET?: string;
  CONTROL_PLAN_PROXY_SECRET?: string;
  CONTROL_PLAN_INTERNAL_SECRET?: string;
  GITHUB_USER_LOGIN?: string;
  GITHUB_USER_EMAIL?: string;
  MODEL_PROGRESS_TIMEOUT_MS?: string;
  LLM_MODEL: string;
  APPROVAL_MODE: string;
  POSTHOG_HOST: string;
  POSTHOG_PROJECT_TOKEN: string;
  AUTOFIX_CAP_PER_PR: string;
  MAX_CONCURRENT_SESSIONS: string;
  AUTO_CREATE_PR: string;
  ZAI_API_KEY: string;
  WORKER_URL: string;
  CONTROL_PLAN_MCP_TOKEN?: string;
  CONTROL_PLAN_EXECUTION_MODE?: string;
}
