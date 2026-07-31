import { describe, expect, it, vi } from "vitest";
import type { BackgroundTaskSnapshot, ProcessManager } from "../core/process-manager.js";
import { formatBackgroundTaskStatus } from "./components/BackgroundTasksBar.js";
import { killTask } from "./stores/taskbar-store.js";
import { createTaskKillFeedback, killTaskWithFeedback } from "./task-kill-feedback.js";

function processManagerWithStop(stop: ProcessManager["stop"]): ProcessManager {
  return { stop } as ProcessManager;
}

describe("background task kill feedback", () => {
  it("formats running, pending, and native completion statuses", () => {
    const task: BackgroundTaskSnapshot = {
      id: "bg-1",
      pid: 123,
      command: "fixture",
      logFile: "fixture.log",
      startedAt: 1,
      completedAt: 2,
      exitCode: null,
      signal: "SIGTERM",
      lastReadOffset: 0,
      logSize: 0,
      isRunning: false,
    };

    expect(formatBackgroundTaskStatus(task)).toBe("signal SIGTERM");
    expect(formatBackgroundTaskStatus({ ...task, exitCode: 7, signal: null })).toBe("exit 7");
    expect(formatBackgroundTaskStatus({ ...task, completedAt: null, isRunning: true })).toBe(
      "running",
    );
    expect(
      formatBackgroundTaskStatus({
        ...task,
        completedAt: null,
        exitCode: null,
        signal: null,
      }),
    ).toBe("completion pending");
  });

  it("returns and awaits ProcessManager.stop before the result reaches the UI", async () => {
    let resolveStop!: (result: string) => void;
    const stop = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const processManager = processManagerWithStop(stop as ProcessManager["stop"]);
    const appendFeedback = vi.fn();

    const pending = killTaskWithFeedback(processManager, "bg-1", "ui-1", appendFeedback);

    expect(stop).toHaveBeenCalledWith("bg-1");
    expect(appendFeedback).not.toHaveBeenCalled();

    resolveStop("Process bg-1 stopped");
    await pending;

    expect(appendFeedback).toHaveBeenCalledOnce();
    expect(appendFeedback).toHaveBeenCalledWith({
      kind: "info",
      text: "Process bg-1 stopped",
      id: "ui-1",
    });
  });

  it("returns the ProcessManager status from the store action", async () => {
    const processManager = processManagerWithStop(vi.fn().mockResolvedValue("status from stop"));

    await expect(killTask(processManager, "bg-2")).resolves.toBe("status from stop");
  });

  it("renders the cross-platform stop failure prefix as a live error item", () => {
    expect(
      createTaskKillFeedback(
        "Failed to stop process bg-3: process did not reach a terminal settled state within 5000 ms and may still be running.",
        "ui-3",
      ),
    ).toEqual({
      kind: "error",
      headline: "Could not stop background task.",
      message:
        "Failed to stop process bg-3: process did not reach a terminal settled state within 5000 ms and may still be running.",
      guidance: "The task may still be running. Try stopping it again.",
      id: "ui-3",
    });
  });

  it("surfaces a not-found status as a live info item", () => {
    expect(createTaskKillFeedback('No background process with id "stale"', "ui-4")).toEqual({
      kind: "info",
      text: 'No background process with id "stale"',
      id: "ui-4",
    });
  });
});
