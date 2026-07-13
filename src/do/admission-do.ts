import { DurableObject } from "cloudflare:workers";

type AdmissionState = {
  holders: Record<string, number>;
};

const STATE_KEY = "admission";
const DEFAULT_LEASE_MS = 3 * 60 * 60 * 1000;

export class ControlPlanAdmissionDurableObject extends DurableObject<Env> {
  async tryAcquire(input: {
    taskId: string;
    limit: number;
    leaseMs?: number;
  }): Promise<{ admitted: boolean; active: number; retryAfterMs?: number }> {
    const now = Date.now();
    const state = await this.readLiveState(now);
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    const current = state.holders[input.taskId];

    if (current || Object.keys(state.holders).length < Math.max(1, input.limit)) {
      state.holders[input.taskId] = now + leaseMs;
      await this.ctx.storage.put(STATE_KEY, state);
      await this.scheduleNextAlarm(state);
      return { admitted: true, active: Object.keys(state.holders).length };
    }

    const nextExpiry = Math.min(...Object.values(state.holders));
    await this.scheduleNextAlarm(state);
    return {
      admitted: false,
      active: Object.keys(state.holders).length,
      retryAfterMs: Math.max(1_000, nextExpiry - now),
    };
  }

  async release(taskId: string): Promise<{ released: boolean; active: number }> {
    const state = await this.readLiveState(Date.now());
    const released = taskId in state.holders;
    delete state.holders[taskId];
    await this.ctx.storage.put(STATE_KEY, state);
    await this.scheduleNextAlarm(state);
    return { released, active: Object.keys(state.holders).length };
  }

  async active(): Promise<number> {
    const state = await this.readLiveState(Date.now());
    await this.ctx.storage.put(STATE_KEY, state);
    await this.scheduleNextAlarm(state);
    return Object.keys(state.holders).length;
  }

  async alarm(): Promise<void> {
    const state = await this.readLiveState(Date.now());
    await this.ctx.storage.put(STATE_KEY, state);
    await this.scheduleNextAlarm(state);
  }

  private async readLiveState(now: number): Promise<AdmissionState> {
    const stored = (await this.ctx.storage.get<AdmissionState>(STATE_KEY)) ?? { holders: {} };
    const holders = Object.fromEntries(
      Object.entries(stored.holders).filter(([, expiresAt]) => expiresAt > now),
    );
    return { holders };
  }

  private async scheduleNextAlarm(state: AdmissionState): Promise<void> {
    const expiries = Object.values(state.holders);
    if (expiries.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...expiries));
  }
}
