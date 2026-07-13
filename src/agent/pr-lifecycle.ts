// ============================================================
// PR Lifecycle — handles GitHub PR creation and push logic.
// Runs inside the Worker (DO context). Tools delegate to this.
// ============================================================

import { GitHubApp, type GitHubAppEnv } from "./github-app";

export interface PrLifecycleEnv extends GitHubAppEnv {
  GITHUB_USER_LOGIN?: string;
}

export interface PushResult {
  success: boolean;
  sha?: string;
  error?: string;
}

export interface PrCreateResult {
  prUrl: string;
  prNumber: number;
}

export interface Params {
  repoOwner: string;
  repoName: string;
}

/**
 * Parse a GitHub repo URL into owner/name parts.
 */
export function parseRepoUrl(url: string): Params {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`Cannot parse GitHub repo URL: ${url}`);
  return { repoOwner: m[1], repoName: m[2] };
}

/**
 * PR lifecycle handler with a repository-scoped GitHub App installation token.
 * Create one instance per session from Worker env.
 */
export class PrLifecycle {
  private github: GitHubApp;

  constructor(env: PrLifecycleEnv) {
    this.github = new GitHubApp(env);
  }

  /** Push a branch to GitHub via Octokit (no sandbox needed). */
  async pushBranch(
    repoOwner: string,
    repoName: string,
    branch: string,
    headSha: string,
    force = false,
  ): Promise<PushResult> {
    try {
      const octokit = (await this.github.getRepositoryAccess(`${repoOwner}/${repoName}`, "write"))
        .client;
      await octokit.rest.git.updateRef({
        owner: repoOwner,
        repo: repoName,
        ref: `heads/${branch}`,
        sha: headSha,
        force,
      });
      return { success: true, sha: headSha };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /** Create a GitHub Pull Request. */
  async createPullRequest(
    repoOwner: string,
    repoName: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<PrCreateResult> {
    const octokit = (await this.github.getRepositoryAccess(`${repoOwner}/${repoName}`, "write"))
      .client;
    const pr = await octokit.rest.pulls.create({
      owner: repoOwner,
      repo: repoName,
      title,
      body,
      head,
      base,
    });
    return {
      prUrl: pr.data.html_url,
      prNumber: pr.data.number,
    };
  }

  /** Get the current HEAD sha of a branch (read-only). */
  async getBranchHeadSha(
    repoOwner: string,
    repoName: string,
    branch: string,
  ): Promise<string | null> {
    try {
      const octokit = (await this.github.getRepositoryAccess(`${repoOwner}/${repoName}`, "read"))
        .client;
      const ref = await octokit.rest.git.getRef({
        owner: repoOwner,
        repo: repoName,
        ref: `heads/${branch}`,
      });
      return ref.data.object.sha;
    } catch {
      return null;
    }
  }
}
