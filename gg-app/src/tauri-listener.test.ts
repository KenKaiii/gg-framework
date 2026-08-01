import { describe, expect, it, vi } from "vitest";
import { createSafeTauriUnlisten, TAURI_MISSING_LISTENER_ENTRY_ERROR } from "./tauri-listener";

function missingListenerEntryError(): TypeError {
  return new TypeError(TAURI_MISSING_LISTENER_ENTRY_ERROR);
}

describe("safe Tauri listener cleanup", () => {
  it("yields once and retries the exact Tauri missing-entry race", async () => {
    const unlisten = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(missingListenerEntryError())
      .mockResolvedValueOnce();
    const yieldTask = vi.fn(async () => undefined);
    const reportError = vi.fn();

    const cleanup = createSafeTauriUnlisten(unlisten, "agent-pane-ready", {
      yieldTask,
      reportError,
    });
    await cleanup();

    expect(unlisten).toHaveBeenCalledTimes(2);
    expect(yieldTask).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reaches backend cleanup after the retry and does not leak duplicate handling", async () => {
    const listeners = new Set<(value: string) => void>();
    const originalHandler = vi.fn();
    listeners.add(originalHandler);
    let firstAttempt = true;
    const backendCleanup = vi.fn(async () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw missingListenerEntryError();
      }
      listeners.delete(originalHandler);
    });
    const cleanup = createSafeTauriUnlisten(backendCleanup, "agent-pane-ready", {
      yieldTask: async () => undefined,
      reportError: vi.fn(),
    });

    for (const listener of listeners) listener("before cleanup");
    await Promise.all([cleanup(), cleanup()]);
    const remountedHandler = vi.fn();
    listeners.add(remountedHandler);
    for (const listener of listeners) listener("after remount");

    expect(backendCleanup).toHaveBeenCalledTimes(2);
    expect(originalHandler).toHaveBeenCalledTimes(1);
    expect(remountedHandler).toHaveBeenCalledTimes(1);
    expect(listeners).toEqual(new Set([remountedHandler]));
  });

  it("does not retry or swallow an unknown cleanup error", async () => {
    const unknownError = new Error("backend refused cleanup");
    const unlisten = vi.fn(async () => {
      throw unknownError;
    });
    const yieldTask = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const cleanup = createSafeTauriUnlisten(unlisten, "window-order", {
      yieldTask,
      reportError,
    });

    await cleanup();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(yieldTask).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith("window-order", unknownError);
  });

  it("reports a retry failure instead of retrying more than once", async () => {
    const retryError = new Error("backend cleanup still failed");
    const unlisten = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(missingListenerEntryError())
      .mockRejectedValueOnce(retryError);
    const reportError = vi.fn();
    const cleanup = createSafeTauriUnlisten(unlisten, "tray-intent", {
      yieldTask: async () => undefined,
      reportError,
    });

    await cleanup();

    expect(unlisten).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith("tray-intent", retryError);
  });
});
