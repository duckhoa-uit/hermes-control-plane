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
}
