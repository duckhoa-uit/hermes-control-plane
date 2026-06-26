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

type Props = Record<string, unknown>;
type Emit = (e: RunnerEventEmit) => void;

// --- Per-event-type handlers -------------------------------------------------
// Each handler is pure (apart from `emit`); message.part.updated is split
// further because the part.type sub-dispatch was the bulk of the complexity.

function handleMessagePartDelta(props: Props, emit: Emit): void {
  const part = (props.part as Props) || {};
  const delta = (props as { delta?: string }).delta;
  if (part.type === "text" && typeof delta === "string" && delta.length > 0) {
    emit({ eventType: "agent.message.delta", eventPayload: { text: delta } });
  }
}

function handleToolPartUpdate(part: Props, emit: Emit, seenToolCalls: Set<string>): void {
  const callID = (part.callID as string) || (part.id as string) || "";
  if (!callID) return;
  const tool = (part.tool as string) || "";
  const state = (part.state as Props) || {};
  const status = state.status as string | undefined;

  if (status === "running" && !seenToolCalls.has(callID)) {
    seenToolCalls.add(callID);
    emit({ eventType: "tool.started", eventPayload: { callID, tool, input: state.input } });
    return;
  }
  if (status === "completed") {
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
    return;
  }
  if (status === "error") {
    emit({ eventType: "tool.completed", eventPayload: { callID, tool, error: state.error } });
  }
}

function handleTextPartUpdate(part: Props, emit: Emit): void {
  const text = (part.text as string) || "";
  if (!text) return;
  emit({
    eventType: "agent.message.complete",
    eventPayload: { text: text.slice(0, 4000) },
  });
}

function handleMessagePartUpdated(props: Props, emit: Emit, seenToolCalls: Set<string>): void {
  const part = (props.part as Props) || {};
  const partType = part.type as string | undefined;
  if (partType === "tool") handleToolPartUpdate(part, emit, seenToolCalls);
  else if (partType === "text") handleTextPartUpdate(part, emit);
}

function handleFileEdited(props: Props, emit: Emit): void {
  const file = (props as { file?: string }).file;
  if (file) emit({ eventType: "file.changed", eventPayload: { file } });
}

function handlePermissionUpdated(props: Props, emit: Emit): void {
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
}

function handleSessionError(props: Props, emit: Emit): void {
  const err = (props as { error?: { message?: string; name?: string } }).error;
  emit({
    eventType: "agent.error",
    eventPayload: { error: err?.message || "unknown", name: err?.name },
  });
}

/** Stateful mapper: tracks per-callID dedup for tool.started. */
export function createEventMapper(emit: Emit) {
  const seenToolCalls = new Set<string>();

  return function map(evt: OpencodeEvent): void {
    if (!evt || typeof evt.type !== "string") return;
    const props = (evt.properties ?? {}) as Props;

    switch (evt.type) {
      case "message.part.delta":
        return handleMessagePartDelta(props, emit);
      case "message.part.updated":
        return handleMessagePartUpdated(props, emit, seenToolCalls);
      case "file.edited":
        return handleFileEdited(props, emit);
      case "permission.updated":
        return handlePermissionUpdated(props, emit);
      case "session.error":
        return handleSessionError(props, emit);
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
  };
}
