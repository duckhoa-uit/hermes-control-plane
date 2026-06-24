// ============================================================
// GitHub Token Broker
// Issues short-lived, repo-scoped tokens via GitHub App JWT
// Control plane uses this; token never injected raw into sandbox
// ============================================================

const GITHUB_API = "https://api.github.com";

interface InstallationToken {
  token: string;
  expiresAt: string;
}

/** Create a GitHub App JWT for authentication. */
async function createAppJWT(appId: string, privateKey: string): Promise<string> {
  // Use Web Crypto API (available in Workers)
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 10 * 60, // 10 min max
    iss: appId,
  };

  const header = { alg: "RS256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await signRS256(signingInput, privateKey);

  return `${signingInput}.${signature}`;
}

/** Get installation ID for a repo. */
async function getInstallationId(
  repoOwner: string,
  repoName: string,
  appJwt: string,
): Promise<number> {
  const resp = await fetch(
    `${GITHUB_API}/repos/${repoOwner}/${repoName}/installation`,
    {
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
      },
    },
  );

  if (!resp.ok) {
    throw new Error(`Failed to get installation: ${resp.status}`);
  }

  const data = (await resp.json()) as { id: number };
  return data.id;
}

/** Issue a short-lived installation token scoped to specific repos. */
export async function getInstallationToken(
  appId: string,
  privateKey: string,
  repoOwner: string,
  repoName: string,
  permissions: Record<string, string> = { contents: "write", pull_requests: "write" },
): Promise<InstallationToken> {
  const appJwt = await createAppJWT(appId, privateKey);
  const installationId = await getInstallationId(repoOwner, repoName, appJwt);

  const resp = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: [repoName],
        permissions,
      }),
    },
  );

  if (!resp.ok) {
    throw new Error(`Failed to create installation token: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    token: string;
    expires_at: string;
  };

  return {
    token: data.token,
    expiresAt: data.expires_at,
  };
}

// ---- Helpers ----

function base64url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signRS256(data: string, privateKeyPem: string): Promise<string> {
  // In Workers, use Web Crypto API
  // Import the PKCS#8 private key
  const pemContents = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data),
  );

  const sigBytes = new Uint8Array(signature);
  let binary = "";
  for (const b of sigBytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Parse owner/repo from a GitHub URL. */
export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) {
    throw new Error(`Cannot parse GitHub repo URL: ${repoUrl}`);
  }
  return { owner: match[1], repo: match[2] };
}
