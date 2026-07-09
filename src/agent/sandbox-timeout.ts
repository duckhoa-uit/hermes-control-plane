import type { SandboxFactory, SessionEnv, ShellOptions } from "@flue/runtime";

type ExecOptions = {
  timeoutMs?: number;
  [key: string]: unknown;
};

export function withDefaultExecTimeout<T extends SandboxFactory>(
  factory: T,
  timeoutMs: number,
): SandboxFactory {
  return {
    ...factory,
    async createSessionEnv(options: { id: string }) {
      const session = await factory.createSessionEnv(options);
      return {
        ...session,
        exec(command: string, options?: ShellOptions): ReturnType<SessionEnv["exec"]> {
          return session.exec(command, {
            ...options,
            timeoutMs: options?.timeoutMs ?? timeoutMs,
          } as ShellOptions);
        },
      };
    },
  };
}
