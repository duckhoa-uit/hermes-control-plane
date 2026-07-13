// ============================================================
// HMAC-based session token auth for replay URLs
// ============================================================
// Signs session IDs with HMAC-SHA256 so the worker can verify
// replay/view access without per-user session tracking.

const ALG = { name: "HMAC", hash: "SHA-256" };
const TOKEN_VERSION = "v1";

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

/**
 * Issues a short-lived, purpose-bound capability token. Tokens are deliberately
 * scoped so a replay URL can never be reused as an internal write credential.
 */
export async function signScopedToken(
  secret: string,
  purpose: string,
  subject: string,
  ttlMs: number,
): Promise<string> {
  if (!secret || !purpose || !subject || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("invalid token inputs");
  }
  const expiresAt = Date.now() + ttlMs;
  const payload = `${TOKEN_VERSION}\u0000${purpose}\u0000${subject}\u0000${expiresAt}`;
  const key = await getKey(secret);
  const signature = await crypto.subtle.sign(ALG, key, new TextEncoder().encode(payload));
  return `${bytesToBase64Url(new TextEncoder().encode(payload))}.${bytesToHex(signature)}`;
}

export async function verifyScopedToken(
  secret: string,
  purpose: string,
  subject: string,
  token: string,
): Promise<boolean> {
  if (!secret || !purpose || !subject || !token) return false;
  try {
    const [encodedPayload, signatureHex] = token.split(".");
    if (!encodedPayload || !signatureHex) return false;
    const payload = new TextDecoder().decode(base64UrlToBytes(encodedPayload));
    const parts = payload.split("\u0000");
    if (
      parts.length !== 4 ||
      parts[0] !== TOKEN_VERSION ||
      parts[1] !== purpose ||
      parts[2] !== subject
    ) {
      return false;
    }
    const expiresAt = Number(parts[3]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) return false;
    const key = await getKey(secret);
    return crypto.subtle.verify(
      ALG,
      key,
      hexToBytes(signatureHex),
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
