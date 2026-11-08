import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleWakeController, type IdleWakeDeps, type IdleWakeSkip } from "./idle-wake.js";

interface HarnessState {
  busy: boolean;
  blocked: boolean;
  pending: boolean;
  seq: number;
  starts: number;
  skips: IdleWakeSkip[];
}

interface Harness {
  controller: IdleWakeController;
  state: HarnessState;
  readonly starts: number;
  readonly skips: IdleWakeSkip[];
}

function harness(overrides: (state: HarnessState) => Partial<IdleWakeDeps> = () => ({})): Harness {
  const state: HarnessState = {
    busy: false,
    blocked: false,
    pending: true,
    seq: 1,
    starts: 0,
    skips: [],
  };
  const controller = new IdleWakeController({
    isBusy: () => state.busy,
    isBlocked: () => state.blocked,
    hasPendingAlert: () => state.pending,
    humanPromptSeq: () => state.seq,
    start: async () => {
      state.starts += 1;
      // The wake run delivers the alert.
      state.pending = false;
    },
    onSkip: (reason) => state.skips.push(reason),
    debounceMs: 1_000,
    maxWakesPerPrompt: 2,
    ...overrides(state),
  });
  return {
    controller,
    state,
    get starts() {
      return state.starts;
    },
    get skips() {
      return state.skips;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IdleWakeController", () => {
  it("starts one run for alerts that land together, after the debounce", async () => {
    const h = harness();
    h.controller.trigger();
    h.controller.trigger();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.starts).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.starts).toBe(1);
  });

  it("waits for a live run instead of starting a second one, then retries", async () => {
    const h = harness();
    h.state.busy = true;
    h.controller.trigger();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.starts).toBe(0);
    // The run ended without draining the alert (it landed after its last
    // steering boundary): the controller must still pick it up.
    h.state.busy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.starts).toBe(1);
  });

  it("starts nothing when the alert was already delivered", async () => {
    const h = harness();
    h.state.pending = false;
    h.controller.trigger();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.starts).toBe(0);
    expect(h.skips).toEqual(["nothing-pending"]);
  });

  it("stays quiet after Stop until the user sends another message", async () => {
    const h = harness();
    h.controller.noteStop();
    h.controller.trigger();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.starts).toBe(0);
    expect(h.skips).toEqual(["stopped"]);

    h.state.seq += 1;
    h.controller.trigger();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.starts).toBe(1);
  });

  it("caps unattended wakes per user message, and resets on the next one", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.state.pending = true;
      h.controller.trigger();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(h.starts).toBe(2);
    expect(h.skips).toEqual(["budget"]);

    h.state.seq += 1;
    h.state.pending = true;
    h.controller.trigger();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.starts).toBe(3);
  });

  it("does not act while the user is reviewing a plan", async () => {
    const h = harness();
    h.state.blocked = true;
    h.controller.trigger();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.starts).toBe(0);
    expect(h.skips).toEqual(["blocked"]);
  });

  it("does nothing once disposed", async () => {
    const h = harness();
    h.controller.trigger();
    h.controller.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    h.controller.trigger();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.starts).toBe(0);
  });

  it("picks up an alert that arrived after the wake run's last steering boundary", async () => {
    const h = harness((state) => ({
      start: async () => {
        state.starts += 1;
        // Delivered, but a new alert lands as the run is finishing.
        state.pending = true;
      },
    }));
    h.controller.trigger();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.starts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.starts).toBe(2);
    // ...and the per-message cap still holds.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.starts).toBe(2);
  });
});
