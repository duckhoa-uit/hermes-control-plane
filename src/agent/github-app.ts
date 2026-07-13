import { SignJWT, importPKCS8 } from "jose";
import { Octokit } from "@octokit/rest";
import { repositoryParts } from "../mcp/task-utils";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

type GitHubAppAccess = "read" | "write";
type GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type GitHubAppEnv = Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">;

export type RepositoryAccess = {
  client: Octokit;
  token: string;
  expiresAt: string;
  installationId: number;
};

export type AuthorizedRepository = RepositoryAccess & {
  repository: string;
  defaultBranch: string;
  baseBranch: string;
};

type CachedToken = RepositoryAccess;

const tokenCache = new Map<string, CachedToken>();

export class GitHubAppError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubAppError";
  }
}

/**
 * GitHub App authentication and repository authorization.
 *
 * Installation access is the repository policy: a task is accepted only when
 * the App is installed on the requested repository. Tokens are requested for
 * one repository and one access level, then cached only until shortly before
 * GitHub's one-hour expiry.
 */
export class GitHubApp {
  private readonly fetchImpl: GitHubFetch;

  constructor(
    private readonly env: GitHubAppEnv,
    fetchImpl: GitHubFetch = globalThis.fetch.bind(globalThis),
  ) {
    this.fetchImpl = fetchImpl;
  }

  async authorizeRepository(
    repository: string,
    requestedBaseBranch?: string,
  ): Promise<AuthorizedRepository> {
    const target = repositoryParts(repository);
    if (!target) throw new GitHubAppError(`Invalid GitHub repository: ${repository}`, 400);

    const access = await this.getRepositoryAccess(repository, "read");
    let metadata: { default_branch?: string };
    try {
      const response = await access.client.rest.repos.get({
        owner: target.owner,
        repo: target.repo,
      });
      metadata = response.data;
    } catch (error) {
      throw githubApiError(error, repository);
    }

    const defaultBranch = metadata.default_branch;
    if (!defaultBranch) {
      throw new GitHubAppError(`GitHub repository ${repository} has no default branch`, 422);
    }

    const baseBranch = requestedBaseBranch || defaultBranch;
    try {
      await access.client.rest.git.getRef({
        owner: target.owner,
        repo: target.repo,
        ref: `heads/${baseBranch}`,
      });
    } catch (error) {
      if (getStatus(error) === 404) {
        throw new GitHubAppError(`Base branch ${baseBranch} does not exist in ${repository}`, 404);
      }
      throw githubApiError(error, repository);
    }

    return { ...access, repository, defaultBranch, baseBranch };
  }

  async getRepositoryAccess(
    repository: string,
    access: GitHubAppAccess,
  ): Promise<RepositoryAccess> {
    const target = repositoryParts(repository);
    if (!target) throw new GitHubAppError(`Invalid GitHub repository: ${repository}`, 400);

    const cacheKey = `${this.env.GITHUB_APP_ID || ""}:${repository}:${access}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && Date.parse(cached.expiresAt) - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return cached;
    }

    const jwt = await this.createAppJwt();
    const installation = await this.requestJson<{ id?: number }>(
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/installation`,
      { authorization: `Bearer ${jwt}` },
      repository,
    );
    if (!installation.id) {
      throw new GitHubAppError(`GitHub App installation is missing for ${repository}`, 403);
    }

    const permissions =
      access === "write" ? { contents: "write", pull_requests: "write" } : { contents: "read" };
    const token = await this.requestJson<{ token?: string; expires_at?: string }>(
      `/app/installations/${installation.id}/access_tokens`,
      {
        method: "POST",
        authorization: `Bearer ${jwt}`,
        body: JSON.stringify({ repositories: [target.repo], permissions }),
      },
      repository,
    );
    if (!token.token || !token.expires_at) {
      throw new GitHubAppError(
        `GitHub did not return an installation token for ${repository}`,
        502,
      );
    }

    const result: RepositoryAccess = {
      client: createOctokit(token.token),
      token: token.token,
      expiresAt: token.expires_at,
      installationId: installation.id,
    };
    tokenCache.set(cacheKey, result);
    return result;
  }

  private async createAppJwt(): Promise<string> {
    const appId = this.env.GITHUB_APP_ID?.trim();
    const privateKey = this.env.GITHUB_APP_PRIVATE_KEY?.trim();
    if (!appId || !privateKey) {
      throw new GitHubAppError(
        "GitHub App is not configured; set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY",
        503,
      );
    }

    try {
      const key = await importPKCS8(normalizePrivateKey(privateKey), "RS256");
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuedAt(now - 60)
        .setExpirationTime(now + 9 * 60)
        .setIssuer(appId)
        .sign(key);
    } catch {
      throw new GitHubAppError(
        "GITHUB_APP_PRIVATE_KEY is invalid; provide the PEM private key downloaded from GitHub",
        503,
      );
    }
  }

  private async requestJson<T>(
    path: string,
    options: { method?: string; authorization: string; body?: string },
    repository: string,
  ): Promise<T> {
    const response = await this.fetchImpl(`${GITHUB_API}${path}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: options.authorization,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "hermes-control-plane",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body,
    });
    if (!response.ok) {
      if (response.status === 404 && path.endsWith("/installation")) {
        throw new GitHubAppError(`GitHub App is not installed for ${repository}`, 403);
      }
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new GitHubAppError(
        `GitHub App authorization failed for ${repository}: ${body.message || response.statusText}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }
}

export function createOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "hermes-control-plane",
    },
  });
}

export function normalizePrivateKey(value: string): string {
  const pem = value.replace(/\\n/g, "\n").trim();
  if (pem.includes("BEGIN PRIVATE KEY")) return pem;
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return pem;

  const pkcs1 = pemToDer(pem);
  const algorithmIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const privateKey = derEncode(0x04, pkcs1);
  const pkcs8 = derEncode(0x30, concat(version, algorithmIdentifier, privateKey));
  return `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(pkcs8)}\n-----END PRIVATE KEY-----`;
}

function pemToDer(pem: string): Uint8Array {
  const encoded = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derEncode(tag: number, value: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function githubApiError(error: unknown, repository: string): GitHubAppError {
  if (error instanceof GitHubAppError) return error;
  return new GitHubAppError(
    `GitHub repository authorization failed for ${repository}: ${error instanceof Error ? error.message : String(error)}`,
    getStatus(error),
  );
}

function getStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}
