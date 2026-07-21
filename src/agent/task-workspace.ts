import type { ExecutionSession } from "@cloudflare/sandbox";
import type { CodingTaskRecord } from "../do/coding-task-do";
import { GitHubApp } from "./github-app";
import { shellQuote } from "./finalizer";

const DEFAULT_CLONE_TIMEOUT_MS = 15 * 60 * 1000;

/** Provision a task's private checkout through an explicit Sandbox session. */
export async function ensureTaskWorkspace(
  env: Env,
  task: CodingTaskRecord,
  session: ExecutionSession,
  timeout = DEFAULT_CLONE_TIMEOUT_MS,
): Promise<string> {
  const [owner, repo] = task.repository.split("/");
  const repoPath = `/workspace/${repo}`;
  const askpassPath = `/tmp/control-plan-askpass-${task.id.slice(-12)}`;
  const githubAccess = await new GitHubApp(env).getRepositoryAccess(task.repository, "read");
  const command = [
    "set -eu",
    // The explicit session is persistent. A fast-path `exit` would terminate
    // the provider-owned shell and make later Flue tool calls fail.
    `if [ -d ${shellQuote(`${repoPath}/.git`)} ]; then :; else`,
    `  rm -rf ${shellQuote(repoPath)}`,
    `  askpass=${shellQuote(askpassPath)}`,
    `  trap 'rm -f "$askpass"' EXIT`,
    `  printf '%s\\n' '#!/bin/sh' 'printf "%s\\n" "$CONTROL_PLAN_GITHUB_APP_TOKEN"' > "$askpass"`,
    `  chmod 700 "$askpass"`,
    `  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$askpass" git -c credential.helper= clone --branch ${shellQuote(task.baseBranch)} --single-branch https://x-access-token@github.com/${owner}/${repo}.git ${shellQuote(repoPath)}`,
    "fi",
  ].join("\n");

  const result = await session.exec(command, {
    timeout,
    env: { CONTROL_PLAN_GITHUB_APP_TOKEN: githubAccess.token },
  });
  if (result.exitCode !== 0) {
    throw new Error(`Repository clone failed: ${result.stderr || result.stdout}`);
  }
  return repoPath;
}
