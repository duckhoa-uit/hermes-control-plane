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

export type SandboxRecoveryErrorKind = "transient_reset" | "timeout" | "terminal";

type SandboxRecoveryMode = "safe" | "unknown" | "write";

type ReconciliationResult<T> = { resolved: true; value: T } | { resolved: false };

export type SandboxRecoveryOperation =
  | "readFile"
  | "readFileBuffer"
  | "writeFile"
  | "stat"
  | "readdir"
  | "exists"
  | "mkdir"
  | "rm"
  | "exec";

export type SandboxRecoveryEvent = {
  operation: SandboxRecoveryOperation;
  errorKind: SandboxRecoveryErrorKind | "unknown_outcome" | "circuit_open";
  attempt: number;
  retryable: boolean;
  sessionReacquired?: boolean;
};

export type SandboxRecoveryOptions = {
  maxRecoveryAttempts?: number;
  backoffMs?: number | ((attempt: number) => number);
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRecoveryEvent?: (event: SandboxRecoveryEvent) => void;
};

const DEFAULT_MAX_RECOVERY_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 25;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 1_000;

/** Raised when a mutation may have reached the sandbox and must be reconciled. */
export class SandboxUnknownOutcomeError extends Error {
  readonly operation: SandboxRecoveryOperation;

  constructor(operation: SandboxRecoveryOperation) {
    super(
      `Cloudflare Sandbox ${operation} returned an uncertain result; reconcile the workspace before retrying the mutation.`,
    );
    this.name = "SandboxUnknownOutcomeError";
    this.operation = operation;
  }
}

/** Raised while the adapter is cooling down after repeated infrastructure failures. */
export class SandboxRecoveryCircuitOpenError extends Error {
  readonly operation: SandboxRecoveryOperation;

  constructor(operation: SandboxRecoveryOperation) {
    super(`Cloudflare Sandbox recovery circuit is open for ${operation}; retry later.`);
    this.name = "SandboxRecoveryCircuitOpenError";
    this.operation = operation;
  }
}

class SandboxWriteVerificationError extends Error {
  constructor(path: string) {
    super(`Cloudflare Sandbox write verification failed for ${path}.`);
    this.name = "SandboxWriteVerificationError";
  }
}

/**
 * Classify provider failures without relying on a single SDK error class. The
 * SDK preserves structured errors, while platform resets may cross an RPC
 * boundary as ordinary Error instances.
 */
export function classifySandboxError(error: unknown): {
  kind: SandboxRecoveryErrorKind;
  retryable: boolean;
} {
  if (isDurableObjectCodeUpdateResetSafely(error)) {
    return { kind: "terminal", retryable: false };
  }

  const name = error instanceof Error ? error.name : "";
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);

  if (
    /timeout|deadline/i.test(name) ||
    /timeout|timed out|deadline exceeded/i.test(code) ||
    /timeout|timed out|deadline exceeded/i.test(message)
  ) {
    return { kind: "timeout", retryable: true };
  }

  if (
    isPlatformTransientErrorSafely(error) ||
    [
      "CONTAINER_UNAVAILABLE",
      "OPERATION_INTERRUPTED",
      "RPC_TRANSPORT_ERROR",
      "SESSION_TERMINATED",
    ].includes(code) ||
    /containerunavailable|operationinterrupted|rpctransport|sessionterminated|sessionnotfound/i.test(
      name,
    ) ||
    /durable object.*(reset|storage|restart)|storage.*reset|session.*(reset|terminated)|rpc.*(transport|connection)|connection.*(closed|reset)|peer.*closed|socket.*closed/i.test(
      message,
    )
  ) {
    return { kind: "transient_reset", retryable: true };
  }

  return { kind: "terminal", retryable: false };
}

/**
 * Bind Flue to an explicit Cloudflare Sandbox execution session.
 *
 * Session wrappers are deliberately resolved lazily and invalidated after a
 * classified reset. The next attempt obtains a fresh wrapper for the same
 * task-bound session ID.
 */
// oxlint-disable-next-line max-lines-per-function
export function cloudflareSessionSandbox(
  sandbox: CloudflareSandbox,
  options: CloudflareSandboxSessionOptions,
  recoveryOptions: SandboxRecoveryOptions = {},
): SandboxFactory {
  const cwd = options.cwd ?? "/workspace";
  const maxRecoveryAttempts = nonNegativeInt(
    recoveryOptions.maxRecoveryAttempts,
    DEFAULT_MAX_RECOVERY_ATTEMPTS,
  );
  const circuitBreakerThreshold = positiveInt(
    recoveryOptions.circuitBreakerThreshold,
    DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  );
  const circuitBreakerCooldownMs = nonNegativeInt(
    recoveryOptions.circuitBreakerCooldownMs,
    DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
  );
  const sleep = recoveryOptions.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const backoffMs = recoveryOptions.backoffMs ?? DEFAULT_BACKOFF_MS;

  let session: ExecutionSession | undefined;
  let consecutiveRecoveryFailures = 0;
  let circuitOpenUntil = 0;

  const invalidateSession = () => {
    session = undefined;
  };

  const resolveSession = async (): Promise<ExecutionSession> => {
    if (!session) session = await getOrCreateSession(sandbox, options.sessionId, cwd);
    return session;
  };

  const emit = (event: SandboxRecoveryEvent): void => {
    try {
      recoveryOptions.onRecoveryEvent?.(event);
    } catch {
      // Telemetry must never change sandbox correctness or recovery behavior.
    }
  };

  const ensureCircuitClosed = (operation: SandboxRecoveryOperation): void => {
    if (Date.now() < circuitOpenUntil) {
      emit({
        operation,
        errorKind: "circuit_open",
        attempt: 0,
        retryable: true,
      });
      throw new SandboxRecoveryCircuitOpenError(operation);
    }
    if (circuitOpenUntil !== 0) circuitOpenUntil = 0;
  };

  const recordFailure = (): void => {
    consecutiveRecoveryFailures += 1;
    if (consecutiveRecoveryFailures >= circuitBreakerThreshold) {
      circuitOpenUntil = Date.now() + circuitBreakerCooldownMs;
    }
  };

  const recordSuccess = (): void => {
    consecutiveRecoveryFailures = 0;
    circuitOpenUntil = 0;
  };

  async function runOperation<T>(
    operation: SandboxRecoveryOperation,
    mode: SandboxRecoveryMode,
    perform: (currentSession: ExecutionSession) => Promise<T>,
    reconcile?: (
      currentSession: ExecutionSession,
      error: unknown,
    ) => Promise<ReconciliationResult<T>>,
  ): Promise<T> {
    let recoveryAttempts = 0;
    let recoveryPending = false;

    while (true) {
      ensureCircuitClosed(operation);
      let operationStarted = false;
      try {
        const currentSession = await resolveSession();
        if (recoveryPending) {
          emit({
            operation,
            errorKind: "transient_reset",
            attempt: recoveryAttempts,
            retryable: true,
            sessionReacquired: true,
          });
          recoveryPending = false;
        }
        operationStarted = true;
        const result = await perform(currentSession);
        recordSuccess();
        return result;
      } catch (error) {
        const failure = classifySandboxError(error);
        if (!failure.retryable) throw error;

        invalidateSession();
        recordFailure();

        if (mode === "write" && operationStarted && reconcile) {
          try {
            const result = await reconcile(await resolveSession(), error);
            if (result.resolved) {
              recordSuccess();
              return result.value;
            }
          } catch {
            invalidateSession();
          }
        }

        if (mode === "unknown" && operationStarted) {
          emit({
            operation,
            errorKind: "unknown_outcome",
            attempt: recoveryAttempts + 1,
            retryable: false,
          });
          throw new SandboxUnknownOutcomeError(operation);
        }

        const nextAttempt = recoveryAttempts + 1;
        const exhausted = nextAttempt > maxRecoveryAttempts;
        emit({
          operation,
          errorKind: failure.kind,
          attempt: nextAttempt,
          retryable: !exhausted,
        });
        if (exhausted) throw error;

        recoveryAttempts = nextAttempt;
        recoveryPending = true;
        await sleep(resolveBackoff(backoffMs, recoveryAttempts));
      }
    }
  }

  return {
    async createSessionEnv(): Promise<SessionEnv> {
      return createSandboxSessionEnv(
        {
          async readFile(path) {
            return runOperation(
              "readFile",
              "safe",
              async (currentSession) => (await currentSession.readFile(path)).content,
            );
          },
          async readFileBuffer(path) {
            return runOperation("readFileBuffer", "safe", async (currentSession) => {
              const file = await currentSession.readFile(path, { encoding: "base64" });
              return decodeBase64(file.content);
            });
          },
          async writeFile(path, content) {
            await writeFileWithRecovery(runOperation, path, content);
          },
          async stat(path) {
            return runOperation("stat", "safe", async (currentSession) => {
              const quoted = shellQuote(path);
              const result = await currentSession.exec(
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
            });
          },
          async readdir(path) {
            return runOperation("readdir", "safe", async (currentSession) => {
              const result = await currentSession.exec(
                `find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%f\\0'`,
              );
              if (!result.success) throw new Error(`readdir failed for ${path}: ${result.stderr}`);
              return result.stdout.split("\0").filter(Boolean);
            });
          },
          async exists(path) {
            return runOperation(
              "exists",
              "safe",
              async (currentSession) => (await currentSession.exists(path)).exists,
            );
          },
          async mkdir(path, mkdirOptions) {
            await runOperation(
              "mkdir",
              mkdirOptions?.recursive ? "safe" : "unknown",
              async (currentSession) => {
                await currentSession.mkdir(path, mkdirOptions);
              },
            );
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
            await runOperation("rm", "unknown", async (currentSession) => {
              await currentSession.deleteFile(path);
            });
          },
          async exec(command, execOptions) {
            return runOperation("exec", "unknown", async (currentSession) => {
              // Cloudflare's RPC transport cannot serialize AbortSignal. Flue
              // may attach one to every tool call, so forward only the
              // serializable execution controls and let the provider timeout
              // bound the remote command.
              const result = await currentSession.exec(command, {
                cwd: execOptions?.cwd,
                env: execOptions?.env,
                timeout: execOptions?.timeoutMs,
              });
              return {
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
              };
            });
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

async function writeFileWithRecovery(
  runOperation: RunSandboxOperation,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const expected = typeof content === "string" ? content : encodeBase64(content);
  const verify = async (session: ExecutionSession): Promise<void> => {
    const readBack = await session.readFile(
      path,
      typeof content === "string" ? undefined : { encoding: "base64" },
    );
    if (readBack.content !== expected) throw new SandboxWriteVerificationError(path);
  };

  await runOperation(
    "writeFile",
    "write",
    async (session: ExecutionSession) => {
      await session.writeFile(
        path,
        expected,
        typeof content === "string" ? undefined : { encoding: "base64" },
      );
      await verify(session);
    },
    async (session: ExecutionSession) => {
      try {
        await verify(session);
        return { resolved: true, value: undefined };
      } catch {
        return { resolved: false };
      }
    },
  );
}

type RunSandboxOperation = <T>(
  operation: SandboxRecoveryOperation,
  mode: SandboxRecoveryMode,
  perform: (session: ExecutionSession) => Promise<T>,
  reconcile?: (session: ExecutionSession, error: unknown) => Promise<ReconciliationResult<T>>,
) => Promise<T>;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as { code?: unknown; errorResponse?: { code?: unknown } };
  return String(value.code ?? value.errorResponse?.code ?? "");
}

function isPlatformTransientErrorSafely(error: unknown): boolean {
  const value = error as {
    errorResponse?: { code?: unknown; context?: { retryable?: unknown } };
    context?: { retryable?: unknown };
  } | null;
  return value?.errorResponse?.context?.retryable === true || value?.context?.retryable === true;
}

function isDurableObjectCodeUpdateResetSafely(error: unknown): boolean {
  const value = error as { code?: unknown; errorResponse?: { code?: unknown } } | null;
  return (
    value?.code === "DURABLE_OBJECT_CODE_UPDATE_RESET" ||
    value?.errorResponse?.code === "DURABLE_OBJECT_CODE_UPDATE_RESET"
  );
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? value : fallback;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function resolveBackoff(value: number | ((attempt: number) => number), attempt: number): number {
  const milliseconds = typeof value === "function" ? value(attempt) : value;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(content: string): Uint8Array {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
