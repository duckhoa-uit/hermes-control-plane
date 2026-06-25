// ============================================================
// Event Log - append-only, replayable, seq-cursored
// ============================================================

import type { HermesEvent, HermesEventType, EventSource } from "./types";

export class EventLog {
  private events: HermesEvent[] = [];
  private nextSeq = 0;

  append(
    sessionId: string,
    type: HermesEventType,
    source: EventSource,
    payload: Record<string, unknown> = {},
  ): HermesEvent {
    const event: HermesEvent = {
      id: `evt_${this.nextSeq}_${Date.now()}`,
      sessionId,
      seq: this.nextSeq,
      type,
      source,
      payload,
      createdAt: Date.now(),
    };
    this.events.push(event);
    this.nextSeq++;
    return event;
  }

  getAll(): HermesEvent[] {
    return [...this.events];
  }

  /** Returns events with seq > lastSeq (for replay on reconnect). */
  getSince(lastSeq: number): HermesEvent[] {
    return this.events.filter((e) => e.seq > lastSeq);
  }

  getLatestSeq(): number {
    return this.nextSeq - 1;
  }

  count(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
    this.nextSeq = 0;
  }

  /**
   * Restore a previously-persisted event into the log, preserving its seq.
   * Caller must pass events in seq order (DO restore() iterates the storage
   * list, which is already sorted by our zero-padded key).
   */
  appendExisting(event: HermesEvent): void {
    this.events.push(event);
    if (event.seq >= this.nextSeq) this.nextSeq = event.seq + 1;
  }
}
