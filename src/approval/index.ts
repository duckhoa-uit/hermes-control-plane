// ============================================================
// requireApproval — Hermes Agent-compatible approval gate (WS hibernation)
// ============================================================

import { classifyCommand } from "./classifier";
import { checkHardline } from "./hardline";
import { trackApproval } from "../core/observability";

export type ApprovalDecision = {
  id: string;
  decision:
    | "once"
    | "session"
    | "always"
    | "deny"
    | "timeout"
    | "auto_approved"
    | "hardline_blocked";
  actor?: string;
  denied: boolean;
};

export interface ApprovalPayload {
  type: string;
  title: string;
  command?: string;
  diff?: string;
  pattern?: string;
  metadata?: Record<string, unknown>;
}

function generateApprovalId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return (
    "approval_" +
    Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

interface ApprovalContext {
  signal?: AbortSignal;
}

const APPROVAL_TIMEOUT_MS = 3600_000; // 1h server-side wait

export async function requireApproval(
  ctx: ApprovalContext,
  payload: ApprovalPayload,
  options?: {
    mode?: "manual" | "smart" | "off";
    sessionId?: string;
    workerUrl?: string;
    approvalDOBinding?: any;
  },
): Promise<ApprovalDecision> {
  const startTime = Date.now();
  const mode = options?.mode ?? "manual";
  const sessionId = options?.sessionId ?? "unknown";

  // Hardline blocklist: always blocked
  if (payload.command) {
    const block = checkHardline(payload.command);
    if (block) {
      const id = "hardline_" + generateApprovalId();
      trackApproval({
        event: "hardline_block",
        approvalId: id,
        sessionId,
        type: payload.type,
        decision: "hardline_blocked",
        actor: "hardline",
      });
      return { id, decision: "hardline_blocked", denied: true };
    }
  }

  // Mode "off": auto-approve
  if (mode === "off") {
    const id = generateApprovalId();
    return { id, decision: "auto_approved", denied: false };
  }

  // Mode "smart": auto-approve safe commands
  if (mode === "smart" && payload.command) {
    const classification = classifyCommand(payload.command);
    if (!classification) {
      const id = generateApprovalId();
      trackApproval({
        event: "approval_resolved",
        approvalId: id,
        sessionId,
        type: payload.type,
        decision: "auto_approved",
        actor: "classifier",
        latencyMs: Date.now() - startTime,
      });
      return { id, decision: "auto_approved", denied: false };
    }
    payload.pattern = classification.pattern;
  }

  // Manual or smart-flagged: create pending approval.
  // ApprovalDO is the single source of truth for approval state — the replay
  // UI polls /sessions/:id/approvals/open instead of listening for stream
  // data events; ApprovalDO remains the durable source of truth.
  const id = generateApprovalId();

  trackApproval({
    event: "approval_requested",
    approvalId: id,
    sessionId,
    type: payload.type,
  });

  const doBinding = options?.approvalDOBinding;

  // Fallback if no DO binding: sleep + auto-approve (dev only)
  if (!doBinding) {
    await sleep(2000);
    return { id, decision: "auto_approved", denied: false };
  }

  const doId = doBinding.idFromName("approvals");
  const stub = doBinding.get(doId);

  // Register pending approval
  try {
    await stub.fetch(new URL("/request", "http://localhost"), {
      method: "POST",
      body: JSON.stringify({
        id,
        sessionId,
        type: payload.type,
        title: payload.title,
        pattern: payload.pattern,
        payload: {
          command: payload.command,
          diff: payload.diff,
          metadata: payload.metadata,
        },
        timeoutMs: APPROVAL_TIMEOUT_MS,
      }),
    });
  } catch (err) {
    console.error("[approval] DO request failed:", err);
    return { id, decision: "timeout", denied: true };
  }

  // Open a hibernatable WebSocket for the fast path, while polling the
  // persisted DO state as a fallback for missed wake-up messages.
  const decision = await waitForResolutionViaWs(stub, id, ctx.signal);

  trackApproval({
    event: decision.decision === "timeout" ? "approval_timeout" : "approval_resolved",
    approvalId: id,
    sessionId,
    type: payload.type,
    decision: decision.decision,
    actor: decision.actor || "system",
    latencyMs: Date.now() - startTime,
  });

  return decision;
}

/**
 * Open a WebSocket to the ApprovalDurableObject and await a decision.
 * The persisted approval row is polled as a fallback because a WebSocket
 * wake-up can be missed across local runtime or Durable Object restarts.
 */
async function waitForResolutionViaWs(
  stub: any,
  id: string,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  return await new Promise<ApprovalDecision>((resolve) => {
    let settled = false;
    let ws: WebSocket | undefined;
    let wsAvailable = false;
    let pollingAvailable = false;

    const finish = (decision: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(decision);
    };

    const resolvePayload = (data: any) => {
      const decision = data.decision || (data.status === "denied" ? "deny" : data.status);
      if (!decision || decision === "pending") return false;
      const denied =
        decision === "deny" || decision === "timeout" || decision === "hardline_blocked";
      finish({
        id,
        decision,
        actor: data.actor || data.decided_by,
        denied,
      });
      return true;
    };

    const pollOnce = async () => {
      try {
        const response = await stub.fetch(
          new URL(`/get?id=${encodeURIComponent(id)}`, "http://localhost"),
        );
        if (!response.ok) {
          pollingAvailable = false;
          return;
        }
        pollingAvailable = true;
        resolvePayload(await response.json());
      } catch (err) {
        pollingAvailable = false;
        console.error("[approval] state poll failed:", err);
      }
    };

    const onAbort = () => finish({ id, decision: "timeout", actor: "abort", denied: true });
    const pollTimer = setInterval(() => void pollOnce(), 1000);
    const deadlineTimer = setTimeout(
      () => finish({ id, decision: "timeout", actor: "deadline", denied: true }),
      APPROVAL_TIMEOUT_MS,
    );

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    void (async () => {
      try {
        const wsResp = await stub.fetch(
          new URL(`/ws-wait?id=${encodeURIComponent(id)}`, "http://localhost"),
          { headers: { Upgrade: "websocket" } },
        );
        if (wsResp.status === 101 && wsResp.webSocket) {
          wsAvailable = true;
          ws = wsResp.webSocket as WebSocket;
          ws.accept();
          ws.addEventListener("message", (event: MessageEvent) => {
            try {
              const data = typeof event.data === "string" ? JSON.parse(event.data) : null;
              if (data) resolvePayload(data);
            } catch (err) {
              console.error("[approval] WS message parse error:", err);
            }
          });
          ws.addEventListener("close", () => {
            wsAvailable = false;
            void pollOnce();
          });
          ws.addEventListener("error", () => {
            wsAvailable = false;
            void pollOnce();
          });
        } else {
          console.error("[approval] WS upgrade failed", wsResp.status);
        }
      } catch (err) {
        console.error("[approval] WS wait failed:", err);
      }

      await pollOnce();
      if (!settled && !wsAvailable && !pollingAvailable) {
        finish({ id, decision: "timeout", denied: true });
      }
    })();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
