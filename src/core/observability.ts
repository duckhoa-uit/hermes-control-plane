// ============================================================
// Lightweight PostHog observability forwarder
// ============================================================
// Non-blocking event emission. The destination is passed per call so a
// request cannot leak configuration into another Worker request through
// module-global mutable state.

export interface ApprovalMetrics {
  event: "approval_requested" | "approval_resolved" | "approval_timeout" | "hardline_block";
  approvalId: string;
  sessionId: string;
  type: string;
  decision?: string;
  actor?: string;
  latencyMs?: number;
}

export type ObservabilityConfig = {
  host?: string;
  token?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
};

export function trackApproval(
  metrics: ApprovalMetrics,
  config: ObservabilityConfig = {},
): Promise<void> | undefined {
  const host = config.host?.trim();
  const token = config.token?.trim();
  if (!host || !token) return undefined;

  const payload = {
    api_key: token,
    event: "hermes_approval",
    properties: {
      distinct_id: metrics.sessionId,
      approval_event: metrics.event,
      approval_id: metrics.approvalId,
      approval_type: metrics.type,
      decision: metrics.decision || "n/a",
      actor: metrics.actor || "system",
      latency_ms: metrics.latencyMs ?? 0,
      timestamp: new Date().toISOString(),
    },
  };

  const request = fetch(`${host.replace(/\/$/, "")}/capture/`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  })
    .then(() => undefined)
    .catch(() => {
      // Silently ignore — observability must not break the agent
    });

  if (config.waitUntil) {
    config.waitUntil(request);
  } else {
    void request;
  }
  return request;
}
