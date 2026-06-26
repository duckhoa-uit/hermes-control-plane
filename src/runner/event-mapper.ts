// Pure mapping from OpenCode SSE event frames to Hermes runner events.
// Pulled out of sandbox-runner.ts so it can be unit-tested without the
// runner's WebSocket / process-env side effects.
//
// See docs/ROADMAP.md §11.9 / §11.11 for the canonical mapping table.

export interface OpencodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export interface RunnerEventEmit {
  eventType: string;
  eventPayload: Record<string, unknown>;
}

/** Stateful mapper: tracks per-callID dedup for tool.started. */
export function createEventMapper(emit: (e: RunnerEventEmit) => void) {
  const seenToolCalls = new Set<string>();

  function map(evt: OpencodeEvent): void {
    if (!evt || typeof evt.type !== "string") return;
    const props = (evt.properties ?? {}) as Record<string, unknown>;

    switch (evt.type) {
      case "message.part.delta": {
        const part = (props.part as Record<string, unknown>) || {};
        const delta = (props as { delta?: string }).delta;
        if (part.type === "text" && typeof delta === "string" && delta.length > 0) {
          emit({ eventType: "agent.message.delta", eventPayload: { text: delta } });
        }
        return;
      }

      case "message.part.updated": {
        const part = (props.part as Record<string, unknown>) || {};
        const partType = part.type as string | undefined;
        if (partType === "tool") {
          const callID = (part.callID as string) || (part.id as string) || "";
          const tool = (part.tool as string) || "";
          const state = (part.state as Record<string, unknown>) || {};
          const status = state.status as string | undefined;
          if (!callID) return;

          if (status === "running" && !seenToolCalls.has(callID)) {
            seenToolCalls.add(callID);
            emit({ eventType: "tool.started", eventPayload: { callID, tool, input: state.input } });
          } else if (status === "completed") {
            emit({
              eventType: "tool.completed",
              eventPayload: {
                callID,
                tool,
                output: state.output,
                title: state.title,
                metadata: state.metadata,
              },
            });
          } else if (status === "error") {
            emit({
              eventType: "tool.completed",
              eventPayload: { callID, tool, error: state.error },
            });
          }
        } else if (partType === "text") {
          const text = (part.text as string) || "";
          if (text)
            emit({
              eventType: "agent.message.complete",
              eventPayload: { text: text.slice(0, 4000) },
            });
        }
        return;
      }

      case "file.edited": {
        const file = (props as { file?: string }).file;
        if (file) emit({ eventType: "file.changed", eventPayload: { file } });
        return;
      }

      case "permission.updated": {
        // M4 logs only; no gating (P2.1 follow-up).
        emit({
          eventType: "approval.requested",
          eventPayload: {
            id: props.id,
            ptype: props.type,
            title: props.title,
            callID: props.callID,
            metadata: props.metadata,
          },
        });
        return;
      }

      case "session.error": {
        const err = (props as { error?: { message?: string; name?: string } }).error;
        emit({
          eventType: "agent.error",
          eventPayload: { error: err?.message || "unknown", name: err?.name },
        });
        return;
      }

      case "session.idle":
        // Terminal marker; HTTP response on session.prompt is the authoritative
        // signal for runner.complete. See ROADMAP §11.8 step-0 verdict.
        return;

      default:
        // Ignore noise: server.*, plugin.*, catalog.*, reference.*,
        // integration.*, session.next.*, session.status, session.updated,
        // session.diff, message.updated, file.watcher.updated,
        // session.compacted, etc.
        return;
    }
  }

  return map;
}
