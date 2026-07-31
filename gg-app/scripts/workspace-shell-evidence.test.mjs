import { describe, expect, it } from "vitest";
import {
  BoundedTail,
  processTreeSnapshot,
  readProcessTable,
  runEvidenceRuns,
  runSupervisedProcess,
  survivingProcessIds,
} from "./workspace-shell-evidence.mjs";

function nodeEval(source) {
  return [process.execPath, ["-e", source]];
}

const TIMEOUT_OPTIONS = {
  deadlineMs: 150,
  cleanupGraceMs: 2_000,
  survivorSettleMs: 1_000,
  sampleMs: 25,
  tailBytes: 1_024,
};

function expectBoundedTimeout(result) {
  const timeoutTriggerBoundMs = result.deadlineMs + result.cleanupGraceMs;
  const terminationStartedElapsedMs = result.terminationRequestedElapsedMs;

  expect(result.timedOut).toBe(true);
  expect(result.timeoutTriggeredElapsedMs).toEqual(expect.any(Number));
  expect(result.timeoutTriggeredElapsedMs).toBeLessThanOrEqual(timeoutTriggerBoundMs);
  expect(terminationStartedElapsedMs).toEqual(expect.any(Number));
  expect(terminationStartedElapsedMs).toBeLessThanOrEqual(timeoutTriggerBoundMs);

  // Scheduler delay and process cleanup are separate: Windows may dispatch the deadline late,
  // but once termination starts the process tree must still close inside the cleanup grace.
  for (const completedElapsedMs of [
    result.terminationCompletedElapsedMs,
    result.processClosedElapsedMs,
  ]) {
    expect(completedElapsedMs).toEqual(expect.any(Number));
    expect(completedElapsedMs).toBeGreaterThanOrEqual(terminationStartedElapsedMs);
    expect(completedElapsedMs - terminationStartedElapsedMs).toBeLessThanOrEqual(
      result.cleanupGraceMs,
    );
  }
  expect(result.terminationError).toBeNull();
  expect(result.outputTail).toContain("timeout-ready");
  expect(result.processInspectionErrorCount).toBe(0);
  expect(result.survivorCount).toBe(0);
  expect(result.survivorPids).toEqual([]);
}

function timeoutEvidence(run, result, descendantPid = null) {
  return {
    run,
    elapsedMs: result.elapsedMs,
    deadlineMs: result.deadlineMs,
    cleanupGraceMs: result.cleanupGraceMs,
    survivorSettleMs: result.survivorSettleMs,
    sampleMs: result.sampleMs,
    startedAtMs: result.startedAtMs,
    deadlineAtMs: result.deadlineAtMs,
    timeoutTriggeredAtMs: result.timeoutTriggeredAtMs,
    schedulerDelayMs: result.timeoutTriggeredAtMs - result.deadlineAtMs,
    terminationRequestedAtMs: result.terminationRequestedAtMs,
    terminationCompletedAtMs: result.terminationCompletedAtMs,
    terminationDurationMs: result.terminationCompletedAtMs - result.terminationRequestedAtMs,
    processClosedAtMs: result.processClosedAtMs,
    processCloseAfterTerminationMs: result.processClosedAtMs - result.terminationRequestedAtMs,
    survivorCheckCompletedAtMs: result.survivorCheckCompletedAtMs,
    survivorCount: result.survivorCount,
    descendantPid,
  };
}

describe("workspace-shell evidence supervisor", () => {
  it("bounds the combined output tail by bytes", () => {
    const tail = new BoundedTail(8);
    tail.append("first-");
    tail.append("second");

    expect(tail.snapshot()).toEqual({ text: "t-second", bytes: 8, truncated: true });
  });

  it("sums only the root process tree memory", () => {
    const snapshot = processTreeSnapshot(
      [
        { pid: 10, ppid: 1, rssBytes: 100, startedAtMs: 1_000 },
        { pid: 11, ppid: 10, rssBytes: 200, startedAtMs: 1_100 },
        { pid: 12, ppid: 11, rssBytes: 300, startedAtMs: 1_200 },
        { pid: 99, ppid: 1, rssBytes: 900, startedAtMs: 500 },
        { pid: 98, ppid: 10, rssBytes: 800, startedAtMs: 500 },
      ],
      10,
    );

    expect(new Set(snapshot.pids)).toEqual(new Set([10, 11, 12]));
    expect(snapshot.rssBytes).toBe(600);
  });

  it("does not count a reused PID as a surviving process", () => {
    const observed = [{ pid: 42, startedAtMs: 1_000 }];
    const reused = [{ pid: 42, ppid: 1, rssBytes: 100, startedAtMs: 2_000 }];

    expect(survivingProcessIds(observed, reused)).toEqual([]);
    expect(survivingProcessIds(observed, [{ ...reused[0], startedAtMs: 1_000 }])).toEqual([42]);
  });

  it("captures PID, exit status, process-tree memory, output, and zero survivors", async () => {
    const [command, args] = nodeEval(
      "console.log('supervised-ready'); setTimeout(() => { console.error('supervised-done'); }, 1200)",
    );
    const result = await runSupervisedProcess(command, args, {
      deadlineMs: 5_000,
      sampleMs: 50,
      tailBytes: 1_024,
    });

    expect(result.pid).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.spawnError).toBeNull();
    expect(result.peakTreeRssBytes).toBeGreaterThan(0);
    expect(result.processInspectionErrorCount).toBe(0);
    expect(result.processInspectionErrors).toEqual([]);
    expect(result.outputTail).toContain("supervised-ready");
    expect(result.outputTail).toContain("supervised-done");
    expect(result.outputTailBytes).toBeLessThanOrEqual(1_024);
    expect(result.survivorCount).toBe(0);
    expect(result.survivorPids).toEqual([]);
  }, 15_000);

  it("fails closed when process inspection is unavailable", async () => {
    const [command, args] = nodeEval("process.exit(0)");
    const result = await runSupervisedProcess(command, args, {
      deadlineMs: 5_000,
      processTableReader: async () => {
        throw new Error("inspection unavailable");
      },
    });

    expect(result.processInspectionErrorCount).toBeGreaterThan(0);
    expect(result.processInspectionErrors).toContain("inspection unavailable");
    expect(result.peakTreeRssBytes).toBe(0);
    expect(result.outputTail).toContain("supervisor sample failed");
  });

  it("enforces an external deadline and leaves no supervised process alive", async () => {
    const [command, args] = nodeEval("console.log('timeout-ready'); setInterval(() => {}, 1000)");
    const result = await runSupervisedProcess(command, args, TIMEOUT_OPTIONS);

    expectBoundedTimeout(result);
    console.info(`WORKSPACE_SHELL_TIMEOUT=${JSON.stringify(timeoutEvidence(1, result))}`);
  }, 15_000);

  it("repeatedly kills supervised descendants within the cleanup bound", async () => {
    const fixture = [
      "const { spawn } = require('node:child_process')",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "console.log('timeout-ready descendant-pid=' + descendant.pid)",
      "setInterval(() => {}, 1000)",
    ].join("; ");

    for (let run = 1; run <= 5; run += 1) {
      const [command, args] = nodeEval(fixture);
      const result = await runSupervisedProcess(command, args, {
        ...TIMEOUT_OPTIONS,
        deadlineMs: 500,
      });

      expectBoundedTimeout(result);
      const descendantPid = Number(result.outputTail.match(/descendant-pid=(\d+)/)?.[1]);
      expect(descendantPid).toBeGreaterThan(0);
      const disappearanceDeadline = Date.now() + 3_000;
      let descendantStillLive = true;
      while (descendantStillLive && Date.now() < disappearanceDeadline) {
        const liveProcesses = await readProcessTable();
        descendantStillLive = liveProcesses.some(({ pid }) => pid === descendantPid);
        if (descendantStillLive) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(descendantStillLive).toBe(false);
      console.info(
        `WORKSPACE_SHELL_TIMEOUT_STRESS=${JSON.stringify(timeoutEvidence(run, result, descendantPid))}`,
      );
    }
  }, 60_000);

  it("repeats runs and reports memory growth and survivors", async () => {
    let invocation = 0;
    const summary = await runEvidenceRuns({
      runs: 3,
      run: async () => {
        invocation += 1;
        return {
          pid: invocation,
          elapsedMs: 10,
          deadlineMs: 120_000,
          timedOut: false,
          exitCode: 0,
          signal: null,
          spawnError: null,
          peakTreeRssBytes: invocation * 100,
          observedProcessCount: 1,
          processInspectionErrorCount: 0,
          processInspectionErrors: [],
          survivorCount: 0,
          survivorPids: [],
          outputTail: "ok",
          outputTailBytes: 2,
          outputTruncated: false,
        };
      },
    });

    expect(invocation).toBe(3);
    expect(summary.peakTreeRssBytes).toEqual([100, 200, 300]);
    expect(summary.peakGrowthBytes).toBe(200);
    expect(summary.totalSurvivors).toBe(0);
    expect(summary.passed).toBe(true);
  });
});
