import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createTestHarness, type TestHarness } from "wrangler";

const enabled = process.env.RUN_WORKER_HARNESS === "1";

describe.skipIf(!enabled)("Cloudflare Worker runtime harness", () => {
  let server: TestHarness;
  let harnessConfigPath: string;

  beforeAll(async () => {
    const builtConfigPath = resolve("dist/hermes_control_plane/wrangler.json");
    const builtConfig = JSON.parse(await readFile(builtConfigPath, "utf8")) as Record<
      string,
      unknown
    >;
    // Flue's generated config still carries legacy_env for deployment
    // compatibility, while the current Wrangler test harness rejects it.
    delete builtConfig.legacy_env;
    harnessConfigPath = resolve(dirname(builtConfigPath), "wrangler.harness.json");
    await writeFile(harnessConfigPath, JSON.stringify(builtConfig));

    server = createTestHarness({
      // Flue owns the build step and emits a bundled Worker plus the resolved
      // Container configuration. Point the harness at that artifact instead
      // of asking Wrangler to bundle Flue's markdown/skill imports directly.
      workers: [{ configPath: harnessConfigPath }],
    });
    await server.listen();
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    if (harnessConfigPath) await unlink(harnessConfigPath).catch(() => undefined);
  }, 30_000);

  it("runs the health route through workerd", async () => {
    const response = await server.fetch("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("enforces MCP authorization in the real Worker runtime", async () => {
    const response = await server.fetch("/mcp", { method: "GET" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});
