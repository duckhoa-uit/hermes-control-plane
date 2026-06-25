import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "cloudflare:workers": new URL("./tests/_shims/cloudflare-workers.ts", import.meta.url).pathname,
    },
  },
});
