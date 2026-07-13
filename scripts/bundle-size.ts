#!/usr/bin/env bun
// Cloudflare-Worker bundle-size check.
//
// Runs `wrangler deploy --dry-run --outdir .wrangler/bundle-size` to produce
// the same bundle the Worker would deploy, then asserts:
//
//   * total uncompressed bundle bytes ≤ HARD_LIMIT  (Cloudflare Free tier: 3 MiB)
//   * total bytes ≤ BUDGET                          (warn threshold, project budget)
//
// CI gate. Run locally:  bun run scripts/bundle-size.ts
//
// The script also writes a one-line summary to GITHUB_STEP_SUMMARY when
// available so the CI run page surfaces the number without a log dive.

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const OUT_DIR = ".wrangler/bundle-size";

// Cloudflare Workers Free tier upload limit. Hitting this means the deploy
// fails, period — gate at 100% of the limit.
const HARD_LIMIT_BYTES = 100 * 1024 * 1024;

// Project budget. Below the hard limit so we get a warning shot before
// the deploy actually fails. Bump this number deliberately when a real
// new dependency lands.
//
// History: bumped to 2 MiB in PR #47 (error tracking) to accommodate
// @sentry/cloudflare (~1.4 MiB). Reset to 1 MiB after swapping to
// posthog-node (~400 KiB) — bundle now sits comfortably under the
// original budget again.
const BUDGET_BYTES = 30 * 1024 * 1024;

function fmt(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function sumDirSize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) total += sumDirSize(p);
    else total += s.size;
  }
  return total;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  // The Flue entry is generated from the current checkout. Run this here so
  // the standalone CI/local bundle check never consumes a generated entry
  // containing absolute paths from another machine.
  const flueBuild = spawnSync("npx", ["flue", "build", "--target", "cloudflare"], {
    stdio: "inherit",
  });
  if (flueBuild.status !== 0) {
    console.error(`flue build failed with status ${flueBuild.status}`);
    process.exit(2);
  }

  // wrangler deploy --dry-run produces the exact bundle without uploading.
  // We pin --outdir so we can stat the result.
  const r = spawnSync("bunx", ["wrangler", "deploy", "--dry-run", "--outdir", OUT_DIR], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error(`wrangler dry-run failed with status ${r.status}`);
    process.exit(2);
  }

  const total = sumDirSize(OUT_DIR);
  const pctBudget = ((total / BUDGET_BYTES) * 100).toFixed(1);
  const pctHard = ((total / HARD_LIMIT_BYTES) * 100).toFixed(1);

  const line =
    `Worker bundle: ${fmt(total)}   ` +
    `(budget ${fmt(BUDGET_BYTES)} = ${pctBudget}%, hard limit ${fmt(HARD_LIMIT_BYTES)} = ${pctHard}%)`;
  console.log(line);

  // Emit a step summary so the CI run page surfaces the number without
  // a log dive.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    writeFileSync(summaryPath, `## Worker bundle size\n\n\`\`\`\n${line}\n\`\`\`\n`, {
      flag: "a",
    });
  }

  if (total > HARD_LIMIT_BYTES) {
    console.error(
      `\n✗ Bundle (${fmt(total)}) exceeds Cloudflare Free-tier hard limit (${fmt(HARD_LIMIT_BYTES)}).`,
    );
    process.exit(1);
  }
  if (total > BUDGET_BYTES) {
    console.error(
      `\n✗ Bundle (${fmt(total)}) exceeds project budget (${fmt(BUDGET_BYTES)}). ` +
        `Bump the BUDGET constant in scripts/bundle-size.ts if intentional, or find what bloated.`,
    );
    process.exit(1);
  }
  console.log("✓ within budget");
}

main();
