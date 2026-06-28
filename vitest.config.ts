import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: process.env.CI ? ["verbose", "junit", "github-actions"] : ["default"],
    outputFile: { junit: "reports/junit.xml" },
    slowTestThreshold: 300,
    retry: process.env.CI ? 2 : 0,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "reports/coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/index.ts",
        "src/app.ts",
        "src/cloudflare.ts",
        "src/agents/",
        "src/channels/",
        "src/do/",
        "src/core/types.ts",
      ],
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
