import type { ApprovalMode } from "../approval";

export type PublicationAction = "git_push" | "create_pr";

const SENSITIVE_PATHS = [
  /^\.github\/workflows\//,
  /^\.env(?:\.|$)/,
  /(^|\/)(?:secrets?|credentials?)(?:\/|\.|$)/i,
  /(^|\/)(?:terraform|infra|deploy)(?:\/|$)/i,
  /^wrangler(?:\.|$)/,
];

export function isSensitivePublicationPath(path: string): boolean {
  return SENSITIVE_PATHS.some((pattern) => pattern.test(path));
}

export function requiresPublicationApproval(
  mode: ApprovalMode,
  action: PublicationAction,
  input: {
    branch: string;
    force?: boolean;
    draft?: boolean;
    changes?: Array<{ path?: string }>;
  },
): boolean {
  if (mode === "off") return false;
  if (mode === "manual" || mode === "smart") return true;

  if (action === "git_push") {
    return (
      Boolean(input.force) ||
      !input.branch.startsWith("control-plan/") ||
      Boolean(
        input.changes?.some((change) => change.path && isSensitivePublicationPath(change.path)),
      )
    );
  }

  return input.draft !== true;
}
