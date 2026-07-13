import {
  instrument,
  type FlueExecutionContext,
  type FlueExecutionInterceptor,
  type FlueInstrumentation,
  type FlueObservation,
} from "@flue/runtime";
import { ProgressWatchdog } from "./watchdog";

const DEFAULT_MODEL_PROGRESS_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_MODEL_PROGRESS_TIMEOUT_MS = 1_000;
const WATCHDOG_KEY = Symbol.for("hermes.model-progress-watchdog");

export function createModelProgressWatchdog(
  timeoutForContext: (ctx: FlueExecutionContext) => number = resolveTimeout,
): FlueInstrumentation {
  const activeTurns = new Map<string, ProgressWatchdog>();

  const interceptor: FlueExecutionInterceptor = async (operation, ctx, next) => {
    if (operation.type !== "model") return next();

    const watchdog = new ProgressWatchdog(
      timeoutForContext(ctx),
      `model turn ${operation.turnId} without progress`,
    );
    activeTurns.set(operation.turnId, watchdog);
    try {
      return await watchdog.run(next());
    } finally {
      watchdog.stop();
      activeTurns.delete(operation.turnId);
    }
  };

  return {
    key: WATCHDOG_KEY,
    observe(observation: FlueObservation) {
      if (!isModelProgress(observation)) return;
      activeTurns.get(observation.turnId)?.touch();
    },
    interceptor,
    dispose() {
      for (const watchdog of activeTurns.values()) watchdog.stop();
      activeTurns.clear();
    },
  };
}

export function installModelProgressWatchdog(): () => Promise<void> {
  return instrument(createModelProgressWatchdog());
}

function resolveTimeout(ctx: FlueExecutionContext): number {
  const env = ctx.eventContext?.env as { MODEL_PROGRESS_TIMEOUT_MS?: string } | undefined;
  const configured = Number(env?.MODEL_PROGRESS_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured >= MIN_MODEL_PROGRESS_TIMEOUT_MS) {
    return configured;
  }
  return DEFAULT_MODEL_PROGRESS_TIMEOUT_MS;
}

function isModelProgress(
  observation: FlueObservation,
): observation is FlueObservation & { turnId: string } {
  return (
    typeof observation.turnId === "string" &&
    (observation.type === "text_delta" ||
      observation.type === "thinking_delta" ||
      observation.type === "message_start" ||
      observation.type === "message_end")
  );
}
