// Mint a short-lived, repo-scoped GitHub App installation token.
// Runs in Bun/Node (uses createSign from node:crypto). Not safe to call from
// inside the Cloudflare Worker — see docs/ROADMAP.md §9.2.

import { createSign } from "crypto";

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function parseRepoUrl(url: string): { owner: string; repo: string } {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`cannot parse GitHub repo URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}

export async function mintInstallationToken(
  appId: string,
  privateKeyPem: string,
  owner: string,
  repo: string,
): Promise<{ token: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const sig = b64url(signer.sign(privateKeyPem));
  const jwt = `${header}.${payload}.${sig}`;

  const instResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/installation`,
    {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
    },
  );
  if (!instResp.ok) {
    throw new Error(`installation lookup ${instResp.status}: ${await instResp.text()}`);
  }
  const inst = (await instResp.json()) as { id: number };

  const tokResp = await fetch(
    `https://api.github.com/app/installations/${inst.id}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: [repo],
        permissions: { contents: "write", pull_requests: "write" },
      }),
    },
  );
  if (!tokResp.ok) {
    throw new Error(`token mint ${tokResp.status}: ${await tokResp.text()}`);
  }
  const tok = (await tokResp.json()) as { token: string; expires_at: string };
  return { token: tok.token, expiresAt: tok.expires_at };
}
