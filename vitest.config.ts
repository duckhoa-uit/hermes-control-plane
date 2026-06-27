import { defineConfig } from "vitest/config";

// Vitest configuration.
//
// Three things in this file matter for the agent-readiness loop, in
// addition to the bare module-resolution wiring at the bottom:
//
//   1. Test performance tracking — `reporters: ["verbose", "junit"]` +
//      `outputFile.junit` writes a per-test timing breakdown that CI
//      uploads as a workflow artifact. `slowTestThreshold` flags any
//      test slower than 300 ms in the verbose output. See the
//      `tests` job in `.github/workflows/lint.yml` for the upload step.
//
//   2. Flaky test detection — `retry: process.env.CI ? 2 : 0` reruns a
//      failing test up to two extra times on CI only. The junit report
//      includes a `<rerunFailure>` block for each retry, so a green-
//      after-retry test is visibly flaky in the artifact (and reported
//      by the `Test analytics summary` step in CI). Local runs keep
//      `retry: 0` so authors see flakes immediately.
//
//   3. Coverage thresholds — `coverage.thresholds.lines/functions/...`
//      enforce a floor that the `bun run test:coverage` script + the
//      CI `tests` job both block on. The thresholds are deliberately
//      modest — they exist to prevent silent regressions, not to chase
//      100% on infrastructure code. Bump them when the suite grows.
//
// Run locally:
//   bun run test            # plain run, no coverage
//   bun run test:coverage   # coverage gate (mirrors CI)
//   bun run test:watch      # watch mode

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],

    // --- Test performance tracking -------------------------------------
    // `verbose` prints per-test names + durations to stdout. `junit`
    // writes a machine-readable XML report at the path below; CI uploads
    // it as a workflow artifact + feeds it to the test-reporter action
    // so timing + retry info land in the run summary.
    reporters: process.env.CI ? ["verbose", "junit", "github-actions"] : ["default"],
    outputFile: {
      junit: "reports/junit.xml",
    },
    // Any test slower than 300 ms gets the `[SLOW]` annotation in the
    // verbose reporter output.
    slowTestThreshold: 300,

    // --- Flaky test detection ------------------------------------------
    // Retries only on CI: locally, a flake should be loud. On CI, a
    // green-after-retry shows up as a flake in the junit artifact (the
    // `tests` workflow surfaces those in the run summary), so the next
    // PR author has a paper trail to quarantine or fix the test.
    retry: process.env.CI ? 2 : 0,

    // --- Coverage thresholds -------------------------------------------
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "reports/coverage",
      // Limit coverage measurement to the units we ship. Scripts,
      // tests, and generated docs are intentionally excluded — they're
      // not part of the deployable Worker bundle.
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/testing/**",
        "src/runner/**", // runs inside the E2B sandbox image; covered by e2e:full
        "src/launcher/server.ts", // server bootstrap; covered by e2e:real
        "src/worker/index.ts", // route dispatcher; covered by e2e tests
      ],
      // Thresholds: modest but real. CI fails if any falls below.
      // Bump these in the same PR that lifts the actual coverage.
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 70,
      },
    },
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "cloudflare:workers": new URL("./tests/_shims/cloudflare-workers.ts", import.meta.url)
        .pathname,
    },
  },
});
