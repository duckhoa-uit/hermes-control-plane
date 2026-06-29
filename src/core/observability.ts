// ============================================================
// Lightweight PostHog observability forwarder
// ============================================================
// Non-blocking fire-and-forget event emission.

export interface ApprovalMetrics {
  event: "approval_requested" | "approval_resolved" | "approval_timeout" | "hardline_block";
  approvalId: string;
  sessionId: string;
  type: string;
  decision?: string;
  actor?: string;
  latencyMs?: number;
}

let posthogHost: string | null = null;
let posthogToken: string | null = null;

export function configureObservability(host: string, token: string): void {
  if (host && token) {
    posthogHost = host;
    posthogToken = token;
  }
}

export function trackApproval(metrics: ApprovalMetrics): void {
  if (!posthogHost || !posthogToken) return;

  const payload = {
    api_key: posthogToken,
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

  // Fire and forget — don't block the agent
  fetch(`${posthogHost}/capture/`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  }).catch(() => {
    // Silently ignore — observability must not break the agent
  });
}
