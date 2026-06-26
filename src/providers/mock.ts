// ============================================================
// Mock Sandbox Provider
// For local testing without E2B or any external service.
// Simulates sandbox lifecycle in-memory.
// ============================================================

import type {
  SandboxProvider,
  CreateSandboxInput,
  SandboxHandle,
  CommandResult,
} from "../core/types";

interface MockSandbox {
  id: string;
  status: "running" | "paused" | "stopped";
  commands: string[];
  createdAt: number;
}

export class MockSandboxProvider implements SandboxProvider {
  private sandboxes = new Map<string, MockSandbox>();

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const id = `mock_sbx_${Date.now()}`;
    const sbx: MockSandbox = {
      id,
      status: "running",
      commands: [],
      createdAt: Date.now(),
    };
    this.sandboxes.set(id, sbx);

    // Log what would happen
    console.log(`[mock-sandbox] Created sandbox ${id} for session ${input.sessionId}`);
    console.log(`[mock-sandbox] Would clone repo: ${input.repoUrl} branch: ${input.branch}`);
    if (input.setupScript) {
      console.log(`[mock-sandbox] Would run setup: ${input.setupScript}`);
    }

    return {
      sandboxId: id,
      previewUrl: `http://localhost:3000/mock-${id}`,
      status: "running",
    };
  }

  async exec(handle: SandboxHandle, command: string): Promise<CommandResult> {
    const sbx = this.sandboxes.get(handle.sandboxId);
    if (!sbx) {
      return { exitCode: 1, stdout: "", stderr: "Sandbox not found" };
    }

    sbx.commands.push(command);
    console.log(`[mock-sandbox] Exec: ${command}`);

    return {
      exitCode: 0,
      stdout: `[mock output for: ${command}]`,
      stderr: "",
    };
  }

  async exposePort(handle: SandboxHandle, port: number): Promise<string> {
    return `http://localhost:${port}/mock-${handle.sandboxId}`;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const sbx = this.sandboxes.get(handle.sandboxId);
    if (sbx) {
      sbx.status = "stopped";
      console.log(
        `[mock-sandbox] Destroyed sandbox ${handle.sandboxId} (ran ${sbx.commands.length} commands)`,
      );
    }
    this.sandboxes.delete(handle.sandboxId);
  }

  getSandbox(id: string): MockSandbox | undefined {
    return this.sandboxes.get(id);
  }

  listSandboxes(): MockSandbox[] {
    return Array.from(this.sandboxes.values());
  }
}
