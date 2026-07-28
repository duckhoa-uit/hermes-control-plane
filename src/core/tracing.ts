export type WorkerTracing = ExecutionContext["tracing"];
export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/**
 * Create a Cloudflare custom span without making tracing a correctness
 * dependency. The same helper is usable from unit tests with a small fake
 * tracer and from Flue/Worker code with the request or runtime tracer.
 */
export async function withCustomSpan<T>(
  tracing: WorkerTracing | undefined,
  name: string,
  attributes: SpanAttributes,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (!tracing) return operation();

  return tracing.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    try {
      const result = await operation();
      span.setAttribute("control_plan.status", "ok");
      return result;
    } catch (error) {
      span.setAttribute("control_plan.status", "error");
      span.setAttribute("error.type", error instanceof Error ? error.name : "unknown");
      span.setAttribute("error.message", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Resolve the Worker tracer when code is running inside workerd. */
export async function getWorkerTracing(): Promise<WorkerTracing | undefined> {
  try {
    const workers = await import("cloudflare:workers");
    return workers.tracing;
  } catch {
    // Node/Vitest and older local runtimes do not expose the module.
    return undefined;
  }
}
