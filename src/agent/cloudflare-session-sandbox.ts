import {
  createSandboxSessionEnv,
  SandboxOperationUnsupportedError,
  type SandboxFactory,
  type SessionEnv,
} from "@flue/runtime";
import type { ExecutionSession, Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

type CloudflareSandboxSessionOptions = {
  cwd?: string;
  sessionId: string;
};

/**
 * Bind Flue to an explicit Cloudflare Sandbox execution session.
 *
 * Flue's built-in adapter currently calls the provider's implicit methods.
 * Cloudflare is deprecating implicit default sessions, so this adapter owns a
 * deterministic session per Flue harness and routes every operation through
 * that session instead.
 */
export function cloudflareSessionSandbox(
  sandbox: CloudflareSandbox,
  options: CloudflareSandboxSessionOptions,
): SandboxFactory {
  const cwd = options.cwd ?? "/workspace";

  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const session = await getOrCreateSession(sandbox, options.sessionId, cwd);
      return createSandboxSessionEnv(
        {
          async readFile(path) {
            return (await session.readFile(path)).content;
          },
          async readFileBuffer(path) {
            const file = await session.readFile(path, { encoding: "base64" });
            const binary = atob(file.content);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index++) {
              bytes[index] = binary.charCodeAt(index);
            }
            return bytes;
          },
          async writeFile(path, content) {
            if (typeof content === "string") {
              await session.writeFile(path, content);
              return;
            }
            let binary = "";
            for (const byte of content) binary += String.fromCharCode(byte);
            await session.writeFile(path, btoa(binary), { encoding: "base64" });
          },
          async stat(path) {
            const quoted = shellQuote(path);
            const result = await session.exec(
              `stat -L -c '%s/%Y/%F' ${quoted} && stat -c '%F' ${quoted}`,
            );
            if (!result.success) throw new Error(`stat failed for ${path}: ${result.stderr}`);
            const [target = "", self = ""] = result.stdout.trim().split(/\r?\n/);
            const [sizeText, mtimeText, type] = target.split("/");
            const size = Number(sizeText);
            const mtime = Number(mtimeText);
            if (!type || !Number.isFinite(size) || !Number.isFinite(mtime)) {
              throw new Error(`stat returned malformed metadata for ${path}`);
            }
            return {
              isFile: type.includes("regular"),
              isDirectory: type === "directory",
              isSymbolicLink: self.trim() === "symbolic link",
              size,
              mtime: new Date(mtime * 1_000),
            };
          },
          async readdir(path) {
            const result = await session.exec(
              `find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%f\\0'`,
            );
            if (!result.success) throw new Error(`readdir failed for ${path}: ${result.stderr}`);
            return result.stdout.split("\0").filter(Boolean);
          },
          async exists(path) {
            return (await session.exists(path)).exists;
          },
          async mkdir(path, mkdirOptions) {
            await session.mkdir(path, mkdirOptions);
          },
          async rm(path, rmOptions) {
            if (rmOptions?.recursive || rmOptions?.force) {
              throw new SandboxOperationUnsupportedError({
                operation: "rm",
                provider: "@cloudflare/sandbox",
                options: [
                  ...(rmOptions.recursive ? ["recursive"] : []),
                  ...(rmOptions.force ? ["force"] : []),
                ],
              });
            }
            await session.deleteFile(path);
          },
          async exec(command, execOptions) {
            // Cloudflare's RPC transport cannot serialize AbortSignal. Flue
            // may attach one to every tool call, so forward only the
            // serializable execution controls and let the provider timeout
            // bound the remote command.
            const result = await session.exec(command, {
              cwd: execOptions?.cwd,
              env: execOptions?.env,
              timeout: execOptions?.timeoutMs,
            });
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            };
          },
        },
        cwd,
      );
    },
  };
}

export async function getOrCreateSession(
  sandbox: CloudflareSandbox,
  sessionId: string,
  cwd = "/workspace",
): Promise<ExecutionSession> {
  try {
    return await sandbox.createSession({ id: sessionId, cwd });
  } catch (error) {
    if (errorName(error) !== "SessionAlreadyExistsError") {
      throw error;
    }
    return sandbox.getSession(sessionId);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}
