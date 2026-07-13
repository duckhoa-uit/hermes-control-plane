export class WatchdogTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "WatchdogTimeoutError";
  }
}

export class ProgressWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reject: ((reason: WatchdogTimeoutError) => void) | undefined;
  private settled = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly label: string,
  ) {}

  run<T>(promise: Promise<T>): Promise<T> {
    if (this.timer || this.settled) {
      throw new Error(`${this.label} watchdog has already started`);
    }

    const timeout = new Promise<never>((_, reject) => {
      this.reject = reject;
      this.schedule();
    });

    return Promise.race([promise, timeout]).finally(() => this.stop());
  }

  touch(): void {
    if (!this.settled) this.schedule();
  }

  stop(): void {
    this.settled = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.reject = undefined;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.settled = true;
      this.reject?.(new WatchdogTimeoutError(this.label, this.timeoutMs));
    }, this.timeoutMs);
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.();
      reject(new WatchdogTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
