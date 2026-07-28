import type { SandboxFactory, SessionEnv, ShellOptions } from "@flue/runtime";

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
        exec(command: string, execOptions?: ShellOptions): ReturnType<SessionEnv["exec"]> {
          return session.exec(command, {
            ...execOptions,
            timeoutMs: execOptions?.timeoutMs ?? timeoutMs,
          } as ShellOptions);
        },
      };
    },
  };
}
