import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesProxySupervisor } from "./hermes-proxy.js";

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), { pid: undefined, exitCode: null }) as ChildProcess;
}

afterEach(() => vi.useRealTimers());

describe("HermesProxySupervisor", () => {
  it("uses a Nous proxy that is already running instead of starting one", async () => {
    const start = vi.fn();
    const sup = new HermesProxySupervisor({
      isConnected: async () => true,
      health: async () => ({ nous: true, authenticated: true }),
      start,
    });
    await sup.ensure();
    expect(start).not.toHaveBeenCalled();
  });

  it("starts one proxy for concurrent callers and restarts it when it dies", async () => {
    vi.useFakeTimers();
    const children: ChildProcess[] = [];
    const start = vi.fn(async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    const sup = new HermesProxySupervisor({
      isConnected: async () => true,
      health: async () => undefined,
      start,
    });
    await Promise.all([sup.ensure(), sup.ensure()]);
    expect(start).toHaveBeenCalledTimes(1);

    children[0]!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not restart after stop() or once Nous Portal is disconnected", async () => {
    vi.useFakeTimers();
    const children: ChildProcess[] = [];
    const start = vi.fn(async () => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    let connected = true;
    const sup = new HermesProxySupervisor({
      isConnected: async () => connected,
      health: async () => undefined,
      start,
    });
    await sup.ensure();
    connected = false;
    children[0]!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(start).toHaveBeenCalledTimes(1);

    connected = true;
    await sup.ensure();
    sup.stop();
    children[1]!.emit("exit", null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
