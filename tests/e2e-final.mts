import { createFlueClient } from "@flue/sdk";

const BASE = "https://hermes-control-plane.duckhoa-dev.workers.dev";
const SESSION = `e2e-full-${Date.now()}`;

async function main() {
  console.log(`\n══════════ FULL CHAIN E2E TEST ══════════\n`);
  console.log(`Session: ${SESSION}\n`);

  const client = createFlueClient({ baseUrl: BASE });

  // ── 1. Health check ──
  console.log("1. Health check...");
  const health = await fetch(`${BASE}/health`);
  const healthJson = await health.json();
  console.log(`   ${health.ok ? '✅' : '❌'} ${JSON.stringify(healthJson)}\n`);

  // ── 2. Prompt with git clone + file read ──
  console.log("2. Full chain: git clone + read file...");
  try {
    const result = await client.agents.prompt("hermes", SESSION, {
      message: `Clone https://github.com/duckhoa-uit/lawn.git to /workspace/lawn, then read /workspace/lawn/README.md and report:
1. What is the project about?
2. What tech stack does it use?
3. List the main directories.`,
    });

    console.log(`\n   ✅ Agent completed!\n`);
    console.log(`   Model: ${result.result.model.provider}/${result.result.model.id}`);
    console.log(`   Tokens: ${result.result.usage.totalTokens} total`);
    console.log(`   Cache reads: ${result.result.usage.cacheRead}`);
    console.log(`\n   ── Assistant Response ──`);
    console.log(result.result.text);
    console.log(`\n   ─────────────────────────\n`);
    
    return 0;
  } catch (err: any) {
    console.log(`\n   ❌ Error:`, err.message);
    if (err.body) {
      try {
        const parsed = typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
        console.log("   ", JSON.stringify(parsed).slice(0, 500));
      } catch {
        console.log("   ", String(err.body).slice(0, 500));
      }
    }
    return 1;
  }
}

const code = await main();
process.exit(code);
