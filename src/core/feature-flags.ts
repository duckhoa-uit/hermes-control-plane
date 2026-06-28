// ============================================================
// Feature flag infrastructure
//
// Lightweight env-var-driven flag system. Lives in src/core/ so both the
// Worker (Cloudflare runtime) can import
// it without a runtime-specific dependency. Reads from Cloudflare Worker
// `env` bindings + `process.env` so flag values can be set per-environment
// via `wrangler secret put` (Worker) or `.dev.vars` (local) or the
//
//
// Design goals:
//   - Zero external service (no LaunchDarkly / Statsig). Sufficient for
//     the kill-switch / progressive-enable use cases an autonomous agent
//     ships behind: roll out a new sandbox image, gate an auto-amend
//     trigger, dark-launch a Worker route.
//   - Booleans + percentage-rollout in one API. No JSON variants.
//   - Pure functions, no I/O — easy to unit-test.
//
// Usage:
//   import { isFlagEnabled, percentageRollout } from "@/core/feature-flags";
//
//   if (isFlagEnabled("autofix_review_changes", env)) { ... }
//
//   // Stable per-key rollout:
//   if (percentageRollout("new_sandbox_image", sessionId, env)) { ... }
// ============================================================

/** A flag source: either Cloudflare Worker env (Record<string, string>),
 *  Node process.env-like, or undefined to fall back to process.env. */
export type FlagSource = Record<string, string | undefined> | undefined;

/**
 * Return true when `FF_<flagName>` is set to one of the truthy strings
 * (`1`, `true`, `on`, `yes`). Anything else — including the env var being
 * absent — returns false. Case-insensitive on the value side.
 *
 * Flag name convention: lowercase snake_case (e.g. `autofix_review_changes`).
 * Stored as `FF_AUTOFIX_REVIEW_CHANGES=1`.
 */
export function isFlagEnabled(flagName: string, env?: FlagSource): boolean {
  const raw = readEnv(`FF_${flagName.toUpperCase()}`, env);
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Stable percentage-rollout gate. Returns true for a deterministic subset
 * of `bucketKey` values; the proportion of true returns is approximately
 * `FF_<flagName>_PCT` (0..100). When the env var is absent, the gate is
 * fully closed (returns false).
 *
 * The bucket assignment is deterministic on `bucketKey`, so a given
 * session / user / PR always sees the same answer until the percentage
 * is changed. We hash with FNV-1a (no Web-Crypto dependency so it runs
 * in both the Worker and Node runtimes without async).
 *
 * Typical use: `percentageRollout("new_sandbox_image", sessionId, env)`.
 */
export function percentageRollout(flagName: string, bucketKey: string, env?: FlagSource): boolean {
  const raw = readEnv(`FF_${flagName.toUpperCase()}_PCT`, env);
  if (!raw) return false;
  const pct = Number.parseFloat(raw);
  if (!Number.isFinite(pct) || pct <= 0) return false;
  if (pct >= 100) return true;
  // FNV-1a 32-bit hash -> [0, 100). Stable across runtimes.
  const bucket = fnv1a32(`${flagName}:${bucketKey}`) % 10_000;
  return bucket < pct * 100; // *100 so we get 0.01% resolution.
}

/**
 * Convenience: read an arbitrary `FF_*` value as a raw string. Useful for
 * variant-shaped flags (e.g. selecting a model name). Returns undefined
 * when unset.
 */
export function flagValue(flagName: string, env?: FlagSource): string | undefined {
  return readEnv(`FF_${flagName.toUpperCase()}`, env);
}

// ---------------------------------------------------------------------------

function readEnv(key: string, env?: FlagSource): string | undefined {
  if (env && key in env) return env[key];
  // Fall back to process.env when no explicit source was passed. The Worker
  // runtime does not populate process.env, so this branch is a no-op there.
  if (typeof process !== "undefined" && process.env) return process.env[key];
  return undefined;
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Make sure we return a positive 32-bit number.
  return h >>> 0;
}
