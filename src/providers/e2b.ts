// ============================================================
// E2B Sandbox Provider (Option B: runtime Bun install)
// Uses E2B SDK. Installs Bun + runner at sandbox creation.
// Runner script is base64-encoded to avoid shell escaping issues.
// ============================================================

import { Sandbox } from "e2b";
import * as fs from "fs";
import * as path from "path";
import type {
  SandboxProvider,
  CreateSandboxInput,
  SandboxHandle,
  CommandResult,
} from "../core/types";

// Read the standalone runner script at module load time
const RUNNER_CODE = fs.readFileSync(
  path.join(__dirname, "..", "runner", "sandbox-runner.ts"),
  "utf-8",
);
const RUNNER_B64 = Buffer.from(RUNNER_CODE).toString("base64");

export class E2BProvider implements SandboxProvider {
  constructor(private apiKey: string, private template: string = "opencode") {}

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const sandbox = await Sandbox.create(this.template, {
      apiKey: this.apiKey,
      timeoutMs: 900_000,
      envs: {
        HERMES_SESSION_ID: input.sessionId,
        HERMES_RUNNER_TOKEN: input.runnerToken,
        HERMES_CONTROL_WS: input.controlWsUrl,
        OPENAI_API_KEY: input.env?.OPENAI_API_KEY ?? "",
        OPENAI_BASE_URL: input.env?.OPENAI_BASE_URL ?? "",
        OPENCODE_MODEL: input.env?.OPENCODE_MODEL ?? "glm-4.6",
        ...input.env,
      },
    });

    // Clone repo
    await sandbox.commands.run(
      `git clone --depth 1 --branch ${input.branch} ${input.repoUrl} /home/user/repo 2>&1 || echo "clone skipped"`,
      { timeoutMs: 60_000 },
    );

    // Run setup script if provided
    if (input.setupScript) {
      await sandbox.commands.run(
        `cd /home/user/repo && bash -c '${input.setupScript}' 2>&1 || true`,
        { timeoutMs: 120_000 },
      );
    }

    // Install Bun
    await sandbox.commands.run(
      "curl -fsSL https://bun.sh/install | bash",
      { timeoutMs: 60_000 },
    );

    // Write runner script via base64 (avoids all escaping issues)
    await sandbox.commands.run(
      `echo "${RUNNER_B64}" | base64 -d > /home/user/hermes-runner.ts`,
      { timeoutMs: 10_000 },
    );

    // Install ws dependency
    await sandbox.commands.run(
      'export PATH="$HOME/.bun/bin:$PATH" && cd /home/user && bun add ws @types/ws 2>&1 || npm install ws 2>&1 || true',
      { timeoutMs: 60_000 },
    );

    // Start runner in background
    await sandbox.commands.run(
      'export PATH="$HOME/.bun/bin:$PATH" && cd /home/user && nohup bun run hermes-runner.ts > /tmp/runner.log 2>&1 &',
      { background: true },
    );

    return {
      sandboxId: sandbox.sandboxId,
      previewUrl: sandbox.getHost(4096),
      status: "running",
    };
  }

  async exec(handle: SandboxHandle, command: string): Promise<CommandResult> {
    const sandbox = await Sandbox.connect(handle.sandboxId, { apiKey: this.apiKey });
    const result = await sandbox.commands.run(command, { timeoutMs: 30_000 });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async exposePort(handle: SandboxHandle, port: number): Promise<string> {
    const sandbox = await Sandbox.connect(handle.sandboxId, { apiKey: this.apiKey });
    return `https://${sandbox.getHost(port)}`;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const sandbox = await Sandbox.connect(handle.sandboxId, { apiKey: this.apiKey });
    await sandbox.kill();
  }
}
