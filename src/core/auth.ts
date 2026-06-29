// ============================================================
// HMAC-based session token auth for replay URLs
// ============================================================
// Signs session IDs with HMAC-SHA256 so the worker can verify
// replay/view access without per-user session tracking.

const ALG = { name: "HMAC", hash: "SHA-256" };

async function getKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey("raw", enc.encode(secret), ALG, false, ["sign", "verify"]);
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export async function signToken(secret: string, sessionId: string): Promise<string> {
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign(ALG, key, new TextEncoder().encode(sessionId));
  return bytesToHex(sig);
}

export async function verifyToken(
  secret: string,
  sessionId: string,
  token: string,
): Promise<boolean> {
  if (!secret || !token) return false;
  try {
    const key = await getKey(secret);
    const expected = hexToBytes(token);
    return crypto.subtle.verify(ALG, key, expected, new TextEncoder().encode(sessionId));
  } catch {
    return false;
  }
}
