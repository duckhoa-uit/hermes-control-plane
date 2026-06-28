// ============================================================
// Shared-secret helpers (constant-time compare).
//
// We re-implement `crypto.timingSafeEqual` in a runtime-portable way so
// the same helper compiles for Cloudflare Workers (no `Buffer`) and
// Avoids pulling in Node crypto polyfill.
// ============================================================

/**
 * Constant-time string compare for shared-secret auth. Avoids leaking
 * the length of the matching prefix via early-exit string equality.
 *
 * Length-mismatch still short-circuits — that information is already
 * exposed by HTTP framing, so the trade-off is acceptable.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
