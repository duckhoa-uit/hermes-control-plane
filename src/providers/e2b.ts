// ============================================================
// E2B Sandbox Provider
// Uses E2B REST API to create/manage sandboxes
// Template: "opencode" (prebuilt with opencode CLI)
// ============================================================

import type {
  SandboxProvider,
  CreateSandboxInput,
  SandboxHandle,
  CommandResult,
} from "../core/types";
import { OPENCODE_PORT } from "../core/constants";

const E2B_BASE = "https://api.e2b.dev/v1";

export class E2BProvider implements SandboxProvider {
  constructor(private apiKey: string, private template: string = "opencode") {}

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const resp = await fetch(`${E2B_BASE}/sandboxes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        templateID: this.template,
        timeout: 900, // 15 min default
        envVars: {
          HERMES_SESSION_ID: input.sessionId,
          HERMES_RUNNER_TOKEN: input.runnerToken,
          HERMES_CONTROL_WS: input.controlWsUrl,
          ...input.env,
        },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`E2B sandbox creation failed: ${resp.status} ${text}`);
    }

    const data = await resp.json<{
      sandboxID: string;
      clientID: string;
    }>();

    // Clone repo inside sandbox
    await this.exec(
      { sandboxId: data.sandboxID, status: "running" },
      `git clone --depth 1 --branch ${input.branch} ${input.repoUrl} /home/user/repo 2>&1 || echo "clone skipped"`,
    );

    // Run setup script if provided
    if (input.setupScript) {
      await this.exec(
        { sandboxId: data.sandboxID, status: "running" },
        `cd /home/user/repo && bash -c '${input.setupScript}' 2>&1 || true`,
      );
    }

    // Start bun runner process in background
    await this.exec(
      { sandboxId: data.sandboxID, status: "running" },
      `cd /home/user/repo && HERMES_SESSION_ID="${input.sessionId}" HERMES_RUNNER_TOKEN="${input.runnerToken}" HERMES_CONTROL_WS="${input.controlWsUrl}" nohup bun run /home/user/hermes-runner.ts > /tmp/runner.log 2>&1 &`,
    );

    return {
      sandboxId: data.sandboxID,
      previewUrl: `https://${data.sandboxID}-${OPENCODE_PORT}.e2b.dev`,
      status: "running",
    };
  }

  async exec(handle: SandboxHandle, command: string): Promise<CommandResult> {
    const resp = await fetch(`${E2B_BASE}/sandboxes/${handle.sandboxId}/processes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        cmd: "sh",
        args: ["-c", command],
        cwd: "/home/user",
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { exitCode: 1, stdout: "", stderr: `E2B exec failed: ${text}` };
    }

    const data = await resp.json<{
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    }>();

    return {
      exitCode: data.exitCode ?? 0,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
    };
  }

  async exposePort(handle: SandboxHandle, port: number): Promise<string> {
    // E2B auto-exposes ports via sandbox URL pattern
    return `https://${handle.sandboxId}-${port}.e2b.dev`;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await fetch(`${E2B_BASE}/sandboxes/${handle.sandboxId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
    });
  }
}
