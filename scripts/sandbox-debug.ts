// Debug helper v2.
import { Sandbox } from "e2b";

const sandboxId = process.argv[2];
const apiKey = process.env.E2B_API_KEY;
if (!sandboxId || !apiKey) {
  console.error("Usage: E2B_API_KEY=... bun run scripts/sandbox-debug.ts <sandboxId>");
  process.exit(2);
}

const sbx = await Sandbox.connect(sandboxId, { apiKey });
console.log(`[connected] ${sandboxId}`);

async function run(cmd: string, label: string) {
  console.log(`\n\x1b[1m▸ ${label}\x1b[0m`);
  console.log(`$ ${cmd}`);
  try {
    const r = await sbx.commands.run(cmd, { timeoutMs: 15_000 });
    if (r.stdout) console.log(r.stdout);
    if (r.stderr) console.error("STDERR:", r.stderr);
    console.log(`(exit ${r.exitCode})`);
  } catch (e) {
    console.error(`(failed: ${(e as Error).message})`);
  }
}

await run("cat /var/log/hermes-supervisor.log", "FULL supervisor.log");
await run("cat /var/log/opencode-serve.log", "FULL opencode-serve.log");
await run("wc -l /var/log/hermes-supervisor.log /var/log/opencode-serve.log", "log sizes");
await run("ps -eo pid,user,etime,stat,command --no-headers | grep -vE '^\\s*\\d+\\s+root\\s+\\S+\\s+[ISR]\\s+\\[' | grep -v 'ps -eo'", "non-kernel processes");
await run("ss -tlnp 2>&1 | head -20 || netstat -tlnp 2>&1 | head -20", "listening ports");
await run("test -f /opt/control-plane/start.json && echo 'start.json exists, mtime:' && stat -c '%y' /opt/control-plane/start.json", "start.json mtime");
await run("stat -c '%y' /var/log/hermes-supervisor.log /var/log/opencode-serve.log", "log mtimes");

// Try to reproduce the spawn from inside the sandbox to see real-time
await run("ls -la /opt/control-plane/runner.js && head -5 /opt/control-plane/runner.js", "runner.js sanity");

process.exit(0);
