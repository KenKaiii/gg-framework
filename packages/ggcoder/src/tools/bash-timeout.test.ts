import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners, once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessManager } from "../core/process-manager.js";
import { PersistentShell } from "../core/persistent-shell.js";
import * as logger from "../core/logger.js";
import { BASH_DIAGNOSTICS_FIXTURE } from "../test-fixtures/bash-diagnostics.js";
import type { BashDiagnostics, BashToolResultDetails } from "../types.js";
import { resolveShell } from "../core/shell.js";
import { killProcessTree, type ProcessTarget } from "../utils/process.js";
import { createBashTool, executeForegroundCommand } from "./bash.js";
import { BOUNDED_OUTPUT_MAX_BYTES, BOUNDED_OUTPUT_MAX_LINES } from "./bounded-output-tail.js";
import { localOperations, type ToolOperations } from "./operations.js";

type BasicProbeName = "cpu" | "silent" | "nested";
type ProbeName = BasicProbeName | "posix-cooperative" | "posix-ignore";

interface FixtureEvidence {
  role: string;
  pid: number;
  ppid: number;
}

type SupervisorOutcome = "child_closed" | "child_error" | "hard_deadline";

interface SupervisedProbeResult {
  probe: ProbeName;
  childPid: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  outerDeadlineFired: boolean;
  supervisorOutcome: SupervisorOutcome;
  roles: FixtureEvidence[];
  timeoutLine: string | null;
  outputTail: string;
}

interface SupervisionOptions {
  deadlineMs?: number;
  postTerminationDeadlineMs?: number;
  childArguments?: string[];
  terminate?: (pid: number) => void;
}

const PROBE_ENV = "GG_BASH_TIMEOUT_PROBE";
const EVIDENCE_ENV = "GG_BASH_TIMEOUT_EVIDENCE_FILE";
const SUPERVISOR_DEADLINE_MS = 12_000;
const POST_TERMINATION_DEADLINE_MS = 2_000;
const MAX_OUTPUT_TAIL = 32 * 1024;
const TEST_FILE = fileURLToPath(import.meta.url);
const VITEST_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))),
  "vitest.mjs",
);
const FOREGROUND_TEST_LOG_ROOT = path.join(
  os.tmpdir(),
  `gg-foreground-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);

function testProcessManager(
  createForegroundLogStream?: (logPath: string) => Writable,
): ProcessManager {
  return new ProcessManager(undefined, undefined, {
    foregroundLogRoot: FOREGROUND_TEST_LOG_ROOT,
    ...(createForegroundLogStream ? { createForegroundLogStream } : {}),
  });
}

function expectedForegroundMetadata(startedAt: number, pid: number | null, timeoutMs = 5_000) {
  return {
    executionId: expect.any(String),
    command: "fixture command",
    cwd: process.cwd(),
    startedAt,
    timeoutMs,
    pid,
    logPath: expect.stringContaining(FOREGROUND_TEST_LOG_ROOT),
  };
}

function expectRenderedDiagnostics(result: string, reason: string): void {
  expect(result).toContain("Execution diagnostics:");
  for (const label of [
    "ID",
    "PID",
    "Command",
    "CWD",
    "Started",
    "Timeout",
    "Exit code",
    "Signal",
    "Elapsed",
    "Log",
  ]) {
    expect(result).toMatch(new RegExp(`\\n${label}: .+`));
  }
  expect(result).toContain(`Reason: ${reason}`);
  expect(result).toContain(`Final output (last ${BOUNDED_OUTPUT_MAX_LINES} lines):`);
  expect(result).toContain("--- begin final output ---");
  expect(result).toContain("--- end final output ---");
}

function structuredBashResult(result: unknown): {
  content: string;
  details: BashToolResultDetails;
} {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    typeof result.content !== "string" ||
    !("details" in result) ||
    typeof result.details !== "object" ||
    result.details === null ||
    !("bashDiagnostics" in result.details)
  ) {
    throw new Error("Expected structured text bash output with diagnostics");
  }
  return result as { content: string; details: BashToolResultDetails };
}

function expectCompletePersistentDiagnostics(
  diagnostics: BashDiagnostics,
  expected: Partial<BashDiagnostics>,
): void {
  expect(Object.keys(diagnostics).sort()).toEqual(Object.keys(BASH_DIAGNOSTICS_FIXTURE).sort());
  expect(diagnostics).toMatchObject({
    executionId: expect.any(String),
    pid: expect.any(Number),
    command: expect.any(String),
    cwd: process.cwd(),
    startedAt: expect.any(Number),
    timeoutMs: expect.any(Number),
    reason: expect.any(String),
    exitCode: null,
    signal: null,
    elapsedMs: expect.any(Number),
    logPath: expect.stringContaining(FOREGROUND_TEST_LOG_ROOT),
    tail: expect.any(String),
    outputCapped: expect.any(Boolean),
    totalOutputBytes: expect.any(Number),
    retainedOutputBytes: expect.any(Number),
    droppedOutputBytes: expect.any(Number),
    ...expected,
  });
}
function quotePathForShell(value: string, isCmdFallback: boolean): string {
  return isCmdFallback ? `"${value}"` : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function appendBounded(current: string, chunk: Buffer): string {
  return (current + chunk.toString("utf8")).slice(-MAX_OUTPUT_TAIL);
}

async function readFixtureEvidence(evidenceFile: string): Promise<FixtureEvidence[]> {
  const text = await fs.readFile(evidenceFile, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as Partial<FixtureEvidence>;
        return typeof value.role === "string" &&
          Number.isInteger(value.pid) &&
          Number.isInteger(value.ppid)
          ? [value as FixtureEvidence]
          : [];
      } catch {
        return [];
      }
    });
}

function terminateSupervisedTree(pid: number): void {
  killProcessTree(pid);
}

async function superviseProbe(
  probe: ProbeName,
  evidenceFile: string,
  options: SupervisionOptions = {},
): Promise<SupervisedProbeResult> {
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    options.childArguments ?? [VITEST_ENTRY, "run", TEST_FILE, "--reporter=verbose"],
    {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        [PROBE_ENV]: probe,
        [EVIDENCE_ENV]: evidenceFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const childPid = child.pid ?? -1;
  const terminate = options.terminate ?? terminateSupervisedTree;
  const deadlineMs = options.deadlineMs ?? SUPERVISOR_DEADLINE_MS;
  const postTerminationDeadlineMs =
    options.postTerminationDeadlineMs ?? POST_TERMINATION_DEADLINE_MS;
  let outputTail = "";
  let outerDeadlineFired = false;
  let startupDeadline: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let hardDeadline: NodeJS.Timeout | undefined;
  let armRuntimeDeadline = (): void => {};

  const settled = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    supervisorOutcome: SupervisorOutcome;
  }>((resolve) => {
    let resolved = false;
    const settle = (result: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      supervisorOutcome: SupervisorOutcome;
    }): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    const terminateAtDeadline = (): void => {
      outerDeadlineFired = true;
      if (childPid > 0) terminate(childPid);
      hardDeadline = setTimeout(() => {
        if (childPid > 0) terminate(childPid);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle({ exitCode: null, signal: null, supervisorOutcome: "hard_deadline" });
      }, postTerminationDeadlineMs);
    };

    child.once("error", () => {
      settle({ exitCode: null, signal: null, supervisorOutcome: "child_error" });
    });
    child.once("close", (exitCode, signal) => {
      settle({ exitCode, signal, supervisorOutcome: "child_closed" });
    });

    startupDeadline = setTimeout(terminateAtDeadline, deadlineMs);
    armRuntimeDeadline = () => {
      if (deadline || outerDeadlineFired) return;
      if (startupDeadline) clearTimeout(startupDeadline);
      deadline = setTimeout(terminateAtDeadline, deadlineMs);
    };
  });

  const captureOutput = (chunk: Buffer): void => {
    outputTail = appendBounded(outputTail, chunk);
    if (/RUN|SUPERVISOR_FIXTURE_READY/.test(outputTail)) armRuntimeDeadline();
  };
  child.stdout.on("data", captureOutput);
  child.stderr.on("data", captureOutput);

  const { exitCode, signal, supervisorOutcome } = await settled.finally(() => {
    if (startupDeadline) clearTimeout(startupDeadline);
    if (deadline) clearTimeout(deadline);
    if (hardDeadline) clearTimeout(hardDeadline);
  });
  const roles = await readFixtureEvidence(evidenceFile);
  const timeoutLine = outputTail.match(/Exit code: TIMEOUT \(\d+ms\)/)?.[0] ?? null;

  return {
    probe,
    childPid,
    exitCode,
    signal,
    elapsedMs: Date.now() - startedAt,
    outerDeadlineFired,
    supervisorOutcome,
    roles,
    timeoutLine,
    outputTail,
  };
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
}

async function cleanupRecordedPids(evidenceFile: string): Promise<void> {
  const roles = await readFixtureEvidence(evidenceFile);
  for (const { pid } of roles.reverse()) {
    if (isAlive(pid)) terminateSupervisedTree(pid);
  }
}

async function waitForFixtureRoles(
  evidenceFile: string,
  expectedRoles: string[],
  timeoutMs = 5_000,
): Promise<FixtureEvidence[]> {
  const deadline = Date.now() + timeoutMs;
  do {
    const roles = await readFixtureEvidence(evidenceFile);
    const recorded = new Set(roles.map(({ role }) => role));
    if (expectedRoles.every((role) => recorded.has(role))) return roles;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for fixture roles: ${expectedRoles.join(", ")}`);
}

async function waitForRecordedPidsToExit(
  roles: FixtureEvidence[],
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    const survivors = roles.filter(({ pid }) => isAlive(pid));
    if (survivors.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const survivors = roles.filter(({ pid }) => isAlive(pid));
  throw new Error(
    `Process-tree cleanup left descendants alive: ${survivors
      .map(({ role, pid }) => `${role}:${pid}`)
      .join(", ")}`,
  );
}

async function runPosixSignalProbe(
  mode: "cooperative" | "ignore",
  reason: "timeout" | "abort",
  evidenceFile: string,
): Promise<void> {
  const controller = new AbortController();
  const fixtureArguments = [
    process.execPath,
    fixturePath("bash-timeout-launcher.mjs"),
    evidenceFile,
    fixturePath("bash-timeout-posix-worker.mjs"),
  ];
  const command = `GG_BASH_TIMEOUT_POSIX_MODE=${mode} ${fixtureArguments
    .map((value) => quotePathForShell(value, false))
    .join(" ")}`;

  try {
    const execution = executeForegroundCommand({
      command,
      cwd: process.cwd(),
      timeoutMs: reason === "timeout" ? 1_000 : 10_000,
      signal: controller.signal,
      ops: localOperations,
      processManager: testProcessManager(),
    });
    const initialRoles = await waitForFixtureRoles(evidenceFile, ["launcher", "worker"]);
    if (reason === "abort") controller.abort();

    const result = await execution;
    expect(result.outcome.reason).toBe(reason === "timeout" ? "timedOut" : "aborted");
    const roles = await waitForFixtureRoles(evidenceFile, ["launcher-term", "worker-term"]);
    const byRole = new Map(initialRoles.map((role) => [role.role, role]));
    const wrapperPid = result.outcome.metadata.pid;
    const launcher = byRole.get("launcher");
    expect(wrapperPid).toBeGreaterThan(0);
    expect(launcher?.pid === wrapperPid || launcher?.ppid === wrapperPid).toBe(true);
    expect(byRole.get("worker")?.ppid).toBe(launcher?.pid);
    expect(roles.find(({ role }) => role === "launcher-term")?.pid).toBe(launcher?.pid);
    expect(roles.find(({ role }) => role === "worker-term")?.pid).toBe(byRole.get("worker")?.pid);
    await waitForRecordedPidsToExit(roles);
    expect(wrapperPid === null || isAlive(wrapperPid)).toBe(false);
  } finally {
    await cleanupRecordedPids(evidenceFile);
  }
}

async function assertSupervisedPosixProbe(mode: "cooperative" | "ignore"): Promise<void> {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-posix-supervisor-"));
  const evidenceFile = path.join(tempDirectory, `${mode}.jsonl`);
  const probe: ProbeName = mode === "cooperative" ? "posix-cooperative" : "posix-ignore";
  try {
    const result = await superviseProbe(probe, evidenceFile);
    expect(result.outerDeadlineFired).toBe(false);
    expect(result.supervisorOutcome).toBe("child_closed");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.roles.map(({ role }) => role)).toEqual(
      expect.arrayContaining(["launcher-term", "worker-term"]),
    );
    await waitForRecordedPidsToExit(result.roles);
  } finally {
    await cleanupRecordedPids(evidenceFile);
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

async function runWindowsPnpmTreeProbe(reason: "timeout" | "abort"): Promise<void> {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-win-tree-"));
  const evidenceFile = path.join(tempDirectory, `${reason}.jsonl`);
  const manager = testProcessManager();
  const controller = new AbortController();
  const fixtureArguments = [
    fixturePath("bash-timeout-pnpm.cmd"),
    process.execPath,
    fixturePath("bash-timeout-package-manager-shim.mjs"),
    evidenceFile,
    fixturePath("bash-timeout-launcher.mjs"),
    fixturePath("bash-timeout-worker.mjs"),
  ];
  const { isCmdFallback } = resolveShell("");
  const command = fixtureArguments
    .map((value) => quotePathForShell(value, isCmdFallback))
    .join(" ");
  try {
    const execution = createBashTool(process.cwd(), manager).execute(
      { command, timeout: reason === "timeout" ? 1_000 : 10_000 },
      { signal: controller.signal, toolCallId: `windows-tree-${reason}` },
    );
    const roles = await waitForFixtureRoles(evidenceFile, [
      "package-manager-shim",
      "launcher",
      "worker",
    ]);
    if (reason === "abort") controller.abort();

    const result = await execution;
    if (typeof result === "string" || typeof result.content !== "string") {
      throw new Error("Expected structured text bash output");
    }
    expect(result.content).toContain(
      reason === "timeout" ? "Exit code: TIMEOUT (1000ms)" : "Exit code: ABORTED",
    );

    const byRole = new Map(roles.map((role) => [role.role, role]));
    expect(byRole.get("launcher")?.ppid).toBe(byRole.get("package-manager-shim")?.pid);
    expect(byRole.get("worker")?.ppid).toBe(byRole.get("launcher")?.pid);
    await waitForRecordedPidsToExit(roles);
  } finally {
    manager.shutdownAll();
    await cleanupRecordedPids(evidenceFile);
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

async function runProbe(probe: BasicProbeName, evidenceFile: string): Promise<void> {
  const manager = testProcessManager();
  const fixtureArguments: Record<BasicProbeName, string[]> = {
    cpu: [process.execPath, fixturePath("bash-timeout-cpu.mjs"), evidenceFile],
    silent: [process.execPath, fixturePath("bash-timeout-silent.mjs"), evidenceFile],
    nested: [
      process.execPath,
      fixturePath("bash-timeout-package-manager-shim.mjs"),
      evidenceFile,
      fixturePath("bash-timeout-launcher.mjs"),
      fixturePath("bash-timeout-worker.mjs"),
    ],
  };
  const { isCmdFallback } = resolveShell("");
  const command = fixtureArguments[probe]
    .map((value) => quotePathForShell(value, isCmdFallback))
    .join(" ");
  const startedAt = Date.now();

  try {
    const result = await createBashTool(process.cwd(), manager).execute(
      { command, timeout: 1_000 },
      { signal: new AbortController().signal, toolCallId: `bash-timeout-${probe}` },
    );
    if (typeof result === "string" || typeof result.content !== "string") {
      throw new Error("Expected structured text bash timeout output");
    }
    const elapsedMs = Date.now() - startedAt;
    const roles = await readFixtureEvidence(evidenceFile);
    const timeoutLine = result.content.match(/Exit code: TIMEOUT \(\d+ms\)/)?.[0] ?? null;

    console.log(
      `PROBE_RESULT=${JSON.stringify({
        probe,
        elapsedMs,
        timeoutLine,
        outputTail: result.content.slice(-4_096),
      })}`,
    );

    expect(roles.map(({ role }) => role)).toContain(probe === "nested" ? "worker" : probe);
    expect(timeoutLine).toBe("Exit code: TIMEOUT (1000ms)");
    expect(elapsedMs).toBeGreaterThanOrEqual(750);
    expect(elapsedMs).toBeLessThan(probe === "nested" ? 10_000 : 4_000);

    if (probe === "cpu") {
      expect(result.content).toMatch(/FIXTURE_ROLE=cpu PID=\d+ PPID=\d+/);
    }
    if (probe === "silent") {
      expect(result.content).not.toContain("FIXTURE_ROLE=silent");
    }
    if (probe === "nested") {
      const byRole = new Map(roles.map((role) => [role.role, role]));
      const shim = byRole.get("package-manager-shim");
      const launcher = byRole.get("launcher");
      const worker = byRole.get("worker");
      expect(shim?.ppid).toBeGreaterThan(0);
      expect(launcher?.ppid).toBe(shim?.pid);
      expect(worker?.ppid).toBe(launcher?.pid);
    }
  } finally {
    manager.shutdownAll();
    await cleanupRecordedPids(evidenceFile);
  }
}

async function assertSupervisedProbe(probe: ProbeName): Promise<void> {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gg bash-timeout 'phase01'-"));
  const evidenceFile = path.join(tempDirectory, `${probe} evidence 'roles'.jsonl`);

  try {
    const result = await superviseProbe(probe, evidenceFile);
    const rootPid =
      probe === "nested"
        ? result.roles.find(({ role }) => role === "package-manager-shim")?.ppid
        : result.roles.find(({ role }) => role === probe)?.ppid;
    console.log(`PHASE01_EVIDENCE=${JSON.stringify({ ...result, rootPid })}`);

    expect(result.roles.map(({ role }) => role)).toContain(probe === "nested" ? "worker" : probe);
    expect(result.elapsedMs).toBeLessThan(
      SUPERVISOR_DEADLINE_MS * 2 + POST_TERMINATION_DEADLINE_MS + 3_000,
    );
    expect(result.outerDeadlineFired).toBe(false);
    expect(result.supervisorOutcome).toBe("child_closed");
    expect(result.exitCode).toBe(0);
    expect(result.timeoutLine).toBe("Exit code: TIMEOUT (1000ms)");

    if (probe === "nested") {
      const byRole = new Map(result.roles.map((role) => [role.role, role]));
      expect(rootPid).toBeGreaterThan(0);
      expect(byRole.get("launcher")?.ppid).toBe(byRole.get("package-manager-shim")?.pid);
      expect(byRole.get("worker")?.ppid).toBe(byRole.get("launcher")?.pid);
    }
  } finally {
    await cleanupRecordedPids(evidenceFile);
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

interface FakeChildHarness {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  ready(): Promise<void>;
  emitClose(code: number | null, signal?: NodeJS.Signals | null): void;
  emitError(error: Error): void;
}

function createFakeChild(pid = 2_000_000_000): FakeChildHarness {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const pendingEvents: Array<{ event: "close" | "error"; args: unknown[] }> = [];
  let executionListenersAttached = false;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  emitter.on("newListener", (event) => {
    if (event !== "close") return;
    executionListenersAttached = true;
    queueMicrotask(() => {
      markReady();
      for (const pending of pendingEvents.splice(0)) {
        if (pending.event !== "error" || emitter.listenerCount("error") > 0) {
          emitter.emit(pending.event, ...pending.args);
        }
      }
    });
  });
  const emitExecutionEvent = (event: "close" | "error", ...args: unknown[]): void => {
    if (emitter.listenerCount(event) > 0) {
      emitter.emit(event, ...args);
    } else if (!executionListenersAttached) {
      pendingEvents.push({ event, args });
    }
  };
  const childState: { exitCode: number | null; signalCode: NodeJS.Signals | null } = {
    exitCode: null,
    signalCode: null,
  };
  Object.defineProperties(emitter, {
    exitCode: { get: () => childState.exitCode },
    signalCode: { get: () => childState.signalCode },
  });
  const child = Object.assign(emitter, { pid, stdout, stderr }) as unknown as ChildProcess;
  return {
    child,
    stdout,
    stderr,
    ready: () => ready,
    emitClose(code, signal = null) {
      childState.exitCode = code;
      childState.signalCode = signal;
      emitExecutionEvent("close", code, signal);
    },
    emitError(error) {
      emitExecutionEvent("error", error);
    },
  };
}

function createPersistentFakeChild(pid = 2_000_000_100): {
  child: ChildProcess;
  markExited(code?: number | null, signal?: NodeJS.Signals | null): void;
} {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const childState: { exitCode: number | null; signalCode: NodeJS.Signals | null } = {
    exitCode: null,
    signalCode: null,
  };
  Object.defineProperties(emitter, {
    exitCode: { get: () => childState.exitCode },
    signalCode: { get: () => childState.signalCode },
    killed: { get: () => false },
  });
  const child = Object.assign(emitter, {
    pid,
    stdin,
    stdout,
    stderr,
    unref: vi.fn(),
  }) as unknown as ChildProcess;
  return {
    child,
    markExited(code = 0, signal = null) {
      childState.exitCode = code;
      childState.signalCode = signal;
    },
  };
}

function operationsFor(child: ChildProcess): ToolOperations {
  return {
    ...localOperations,
    process: { ...localOperations.process, spawn: () => child },
  };
}

function foregroundResourceCounts(fake: FakeChildHarness, signal: AbortSignal) {
  return {
    abort: getEventListeners(signal, "abort").length,
    childClose: fake.child.listenerCount("close"),
    childError: fake.child.listenerCount("error"),
    stdoutData: fake.stdout.listenerCount("data"),
    stdoutError: fake.stdout.listenerCount("error"),
    stdoutEnd: fake.stdout.listenerCount("end"),
    stdoutClose: fake.stdout.listenerCount("close"),
    stderrData: fake.stderr.listenerCount("data"),
    stderrError: fake.stderr.listenerCount("error"),
    stderrEnd: fake.stderr.listenerCount("end"),
    stderrClose: fake.stderr.listenerCount("close"),
    timers: vi.getTimerCount(),
  };
}

function foregroundExecution(
  fake: FakeChildHarness,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    processManager?: ProcessManager;
    onUpdate?: (output: string, totalBytes: number) => void;
    cleanupProcessTree?: (target: ProcessTarget) => Promise<void>;
    reapProcessWrapper?: (target: ProcessTarget) => void;
  } = {},
) {
  return executeForegroundCommand({
    command: "fixture command",
    cwd: process.cwd(),
    timeoutMs: options.timeoutMs ?? 5_000,
    signal: options.signal ?? new AbortController().signal,
    ops: operationsFor(fake.child),
    processManager: options.processManager ?? testProcessManager(),
    onUpdate: options.onUpdate,
    cleanupProcessTree: options.cleanupProcessTree,
    reapProcessWrapper: options.reapProcessWrapper,
  });
}

async function executeRendered(
  fake: FakeChildHarness,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const tool = createBashTool(process.cwd(), testProcessManager(), operationsFor(fake.child));
  const result = await tool.execute(
    {
      command: "fixture command",
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    },
    { signal: options.signal ?? new AbortController().signal, toolCallId: "bash-render" },
  );
  if (typeof result === "string") throw new Error("Expected structured bash output");
  if (typeof result.content !== "string") throw new Error("Expected text bash output");
  return result.content;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(FOREGROUND_TEST_LOG_ROOT, { recursive: true, force: true });
});

const selectedProbe = process.env[PROBE_ENV];
const basicProbes: BasicProbeName[] = ["cpu", "silent", "nested"];
const knownProbes: ProbeName[] = [...basicProbes, "posix-cooperative", "posix-ignore"];

if (selectedProbe !== undefined) {
  if (!knownProbes.includes(selectedProbe as ProbeName)) {
    throw new Error(`Unknown ${PROBE_ENV} value: ${selectedProbe}`);
  }
  const evidenceFile = process.env[EVIDENCE_ENV];
  if (!evidenceFile) throw new Error(`${EVIDENCE_ENV} is required for a probe process`);

  it(`runs the ${selectedProbe} timeout probe`, async () => {
    if (selectedProbe === "posix-cooperative") {
      await runPosixSignalProbe("cooperative", "timeout", evidenceFile);
    } else if (selectedProbe === "posix-ignore") {
      await runPosixSignalProbe("ignore", "abort", evidenceFile);
    } else {
      await runProbe(selectedProbe as BasicProbeName, evidenceFile);
    }
  }, 60_000);
} else {
  describe("foreground execution outcomes", () => {
    it("creates the log before spawn and exposes source-labelled partial output live", async () => {
      const fake = createFakeChild(2_000_000_021);
      const manager = testProcessManager();
      const spawnOperation = vi.fn(() => {
        const logFiles = readdirSync(FOREGROUND_TEST_LOG_ROOT);
        expect(logFiles).toHaveLength(1);
        expect(existsSync(path.join(FOREGROUND_TEST_LOG_ROOT, logFiles[0]!))).toBe(true);
        return fake.child;
      });
      const execution = executeForegroundCommand({
        command: "fixture command",
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        ops: {
          ...localOperations,
          process: { ...localOperations.process, spawn: spawnOperation },
        },
        processManager: manager,
      });
      await fake.ready();

      fake.stdout.write("first\n");
      fake.stderr.write("second\n");
      fake.stdout.write("third\n");
      const [logFile] = await fs.readdir(FOREGROUND_TEST_LOG_ROOT);
      const liveLogPath = path.join(FOREGROUND_TEST_LOG_ROOT, logFile!);
      await vi.waitFor(async () => {
        await expect(fs.readFile(liveLogPath, "utf8")).resolves.toBe(
          "[stdout] first\n[stderr] second\n[stdout] third\n",
        );
      });
      fake.emitClose(0);

      const result = await execution;
      expect(result.outcome.metadata.logPath).toBe(liveLogPath);
      await expect(fs.readFile(result.outcome.metadata.logPath, "utf8")).resolves.toContain(
        "[stderr] second",
      );
    });

    it("does not spawn when aborted during foreground log allocation", async () => {
      const fake = createFakeChild();
      const manager = testProcessManager();
      const allocateForegroundLog = manager.allocateForegroundLog.bind(manager);
      let releaseAllocation!: () => void;
      const allocationBlocked = new Promise<void>((resolve) => {
        releaseAllocation = resolve;
      });
      vi.spyOn(manager, "allocateForegroundLog").mockImplementation(async () => {
        await allocationBlocked;
        return allocateForegroundLog();
      });
      const spawnOperation = vi.fn(() => fake.child);
      const controller = new AbortController();
      const execution = executeForegroundCommand({
        command: "fixture command",
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: controller.signal,
        ops: {
          ...localOperations,
          process: { ...localOperations.process, spawn: spawnOperation },
        },
        processManager: manager,
      });

      controller.abort();
      releaseAllocation();

      await expect(execution).resolves.toMatchObject({
        outcome: { reason: "aborted", metadata: { pid: null } },
      });
      expect(spawnOperation).not.toHaveBeenCalled();
    });

    it("bounds high-volume foreground logging with slow low-watermark storage", async () => {
      const fake = createFakeChild(2_000_000_033);
      const persistedChunks: Buffer[] = [];
      let maximumBufferedBytes = 0;
      const logStream = new Writable({
        highWaterMark: 8,
        write(chunk, _encoding, callback) {
          persistedChunks.push(Buffer.from(chunk));
          setImmediate(() => {
            maximumBufferedBytes = Math.max(maximumBufferedBytes, logStream.writableLength);
            callback();
          });
        },
      });
      const resultPromise = foregroundExecution(fake, {
        processManager: testProcessManager(() => logStream),
      });
      await fake.ready();

      fake.stdout.write("record-0000-😀\n");
      expect(fake.stdout.isPaused()).toBe(true);
      expect(fake.stderr.isPaused()).toBe(true);

      const writeSource = async (source: PassThrough, record: string): Promise<void> => {
        if (!source.write(record)) await once(source, "drain");
      };
      for (let index = 1; index < 600; index += 1) {
        const source = index % 2 === 0 ? fake.stdout : fake.stderr;
        await writeSource(source, `record-${index.toString().padStart(4, "0")}-界\n`);
      }
      const stdoutEnded = once(fake.stdout, "end");
      const stderrEnded = once(fake.stderr, "end");
      fake.stdout.end();
      fake.stderr.end();
      await Promise.all([stdoutEnded, stderrEnded]);
      fake.emitClose(0);

      const result = await resultPromise;
      const persisted = Buffer.concat(persistedChunks).toString("utf8");
      expect(result.outcome.reason).toBe("completed");
      expect(persisted.match(/^\[(?:stdout|stderr)\] /gm)).toHaveLength(600);
      expect(persisted).toContain("[stdout] record-0000-😀");
      expect(persisted).toContain("[stderr] record-0599-界");
      expect(persisted).not.toContain("�");
      expect(maximumBufferedBytes).toBeLessThan(1_024);
    });

    it("does not spawn when the foreground log stream fails to open asynchronously", async () => {
      const error = new Error("foreground log open failed");
      const logStream = new PassThrough();
      Object.defineProperty(logStream, "pending", { value: true });
      const manager = testProcessManager(() => {
        queueMicrotask(() => logStream.emit("error", error));
        return logStream;
      });
      const spawnOperation = vi.fn();

      const execution = executeForegroundCommand({
        command: "fixture command",
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        ops: {
          ...localOperations,
          process: { ...localOperations.process, spawn: spawnOperation },
        },
        processManager: manager,
      });

      await expect(execution).rejects.toBe(error);
      expect(spawnOperation).not.toHaveBeenCalled();
    });

    it("spawns the foreground shell as a detached process-group owner", async () => {
      const fake = createFakeChild();
      const spawnOperation = vi.fn(() => fake.child);
      const execution = executeForegroundCommand({
        command: "fixture command",
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        ops: {
          ...localOperations,
          process: { ...localOperations.process, spawn: spawnOperation },
        },
        processManager: testProcessManager(),
      });
      await fake.ready();
      fake.emitClose(0);
      await execution;

      expect(spawnOperation).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ detached: true }),
      );
    });

    it("routes abort through the custom process lifecycle adapter", async () => {
      const controller = new AbortController();
      const fake = createFakeChild(2_000_000_018);
      const cleanupProcessTree = vi.fn(async () => {});
      const ops = operationsFor(fake.child);
      ops.process = { ...ops.process, cleanupProcessTree };
      const execution = executeForegroundCommand({
        command: "fixture command",
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: controller.signal,
        ops,
        processManager: testProcessManager(),
      });
      await fake.ready();

      controller.abort();
      fake.emitClose(null, "SIGTERM");

      await expect(execution).resolves.toMatchObject({ outcome: { reason: "aborted" } });
      expect(cleanupProcessTree).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 2_000_000_018, isExited: expect.any(Function) }),
      );
    });

    it("routes normal completion through the custom wrapper-reap adapter", async () => {
      const fake = createFakeChild(2_000_000_019);
      const reapProcessWrapper = vi.fn();
      const ops = operationsFor(fake.child);
      ops.process = { ...ops.process, reapProcessWrapper };
      const execution = executeForegroundCommand({
        command: "fixture command",
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        ops,
        processManager: testProcessManager(),
      });
      await fake.ready();

      fake.emitClose(0);

      await expect(execution).resolves.toMatchObject({ outcome: { reason: "completed" } });
      expect(reapProcessWrapper).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 2_000_000_019, isExited: expect.any(Function) }),
      );
    });

    it.each([
      [0, "completed"],
      [7, "nonZeroExit"],
    ] as const)("routes exit code %i through wrapper-only reap", async (code, reason) => {
      const controller = new AbortController();
      const fake = createFakeChild(2_000_000_020 + code);
      const cleanupProcessTree = vi.fn(async () => {});
      const reapProcessWrapper = vi.fn();
      const resultPromise = foregroundExecution(fake, {
        signal: controller.signal,
        cleanupProcessTree,
        reapProcessWrapper,
      });
      await fake.ready();

      fake.emitClose(code);
      const result = await resultPromise;
      controller.abort();
      await Promise.resolve();

      expect(result.outcome.reason).toBe(reason);
      expect(reapProcessWrapper).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 2_000_000_020 + code, isExited: expect.any(Function) }),
      );
      const [target] = reapProcessWrapper.mock.calls[0] as [ProcessTarget];
      expect(target.isExited?.()).toBe(true);
      expect(cleanupProcessTree).not.toHaveBeenCalled();
    });

    it("records completed metadata independently", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const fake = createFakeChild(2_000_000_001);
      const resultPromise = foregroundExecution(fake);
      await fake.ready();
      vi.advanceTimersByTime(25);
      fake.emitClose(0);

      const { outcome } = await resultPromise;
      expect(outcome).toEqual({
        reason: "completed",
        exitCode: 0,
        signal: null,
        metadata: expectedForegroundMetadata(10_000, 2_000_000_001),
        elapsedMs: 25,
        error: null,
      });
    });

    it("records a numeric non-zero exit", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(20_000);
      const fake = createFakeChild(2_000_000_002);
      const resultPromise = foregroundExecution(fake);
      fake.emitClose(7);

      expect((await resultPromise).outcome).toEqual({
        reason: "nonZeroExit",
        exitCode: 7,
        signal: null,
        metadata: expectedForegroundMetadata(20_000, 2_000_000_002),
        elapsedMs: 0,
        error: null,
      });
    });

    it("preserves a signal without fabricating an exit code", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(30_000);
      const fake = createFakeChild(2_000_000_003);
      const resultPromise = foregroundExecution(fake);
      fake.emitClose(null, "SIGTERM");

      expect((await resultPromise).outcome).toEqual({
        reason: "nonZeroExit",
        exitCode: null,
        signal: "SIGTERM",
        metadata: expectedForegroundMetadata(30_000, 2_000_000_003),
        elapsedMs: 0,
        error: null,
      });
    });

    it("keeps the first emitted spawn error when close races afterward", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(40_000);
      const fake = createFakeChild(2_000_000_004);
      const error = new Error("missing executable");
      const resultPromise = foregroundExecution(fake);
      let fulfillmentCount = 0;
      void resultPromise.then(() => fulfillmentCount++);
      fake.emitError(error);
      fake.emitClose(0);
      fake.emitError(new Error("later error"));

      const { outcome } = await resultPromise;
      await Promise.resolve();
      expect(outcome).toEqual({
        reason: "spawnError",
        exitCode: null,
        signal: null,
        metadata: expectedForegroundMetadata(40_000, 2_000_000_004),
        elapsedMs: 0,
        error,
      });
      expect(fulfillmentCount).toBe(1);
    });

    it.each(["stdout", "stderr"] as const)(
      "ignores %s pipe errors and settles exactly once from child close",
      async (pipe) => {
        vi.useFakeTimers();
        vi.setSystemTime(45_000);
        const fake = createFakeChild(2_000_000_007);
        const resultPromise = foregroundExecution(fake);
        await fake.ready();
        let fulfillmentCount = 0;
        let fulfilled = false;
        void resultPromise.then(() => {
          fulfillmentCount++;
          fulfilled = true;
        });

        fake[pipe].emit("error", new Error(`${pipe} pipe failed`));
        await Promise.resolve();
        expect(fulfilled).toBe(false);

        vi.advanceTimersByTime(15);
        fake.emitClose(0);
        fake.emitClose(9);
        fake.emitError(new Error("later child error"));

        const { outcome } = await resultPromise;
        await Promise.resolve();
        expect(outcome).toEqual({
          reason: "completed",
          exitCode: 0,
          signal: null,
          metadata: expectedForegroundMetadata(45_000, 2_000_000_007),
          elapsedMs: 15,
          error: null,
        });
        expect(fulfillmentCount).toBe(1);
      },
    );

    it("preserves split UTF-8 characters in per-stream live updates and raw output", async () => {
      const fake = createFakeChild(2_000_000_008);
      const updates: string[] = [];
      const totals: number[] = [];
      const resultPromise = foregroundExecution(fake, {
        onUpdate(output, totalBytes) {
          updates.push(output);
          totals.push(totalBytes);
        },
      });
      await fake.ready();
      const stdout = Buffer.from("stdout: 😀\n");
      const stderr = Buffer.from("stderr: 界\n");
      const stdoutSplit = stdout.indexOf(Buffer.from("😀")) + 2;
      const stderrSplit = stderr.indexOf(Buffer.from("界")) + 1;

      fake.stdout.write(stdout.subarray(0, stdoutSplit));
      fake.stdout.write(stdout.subarray(stdoutSplit));
      fake.stdout.end();
      fake.stderr.write(stderr.subarray(0, stderrSplit));
      fake.stderr.write(stderr.subarray(stderrSplit));
      fake.stderr.end();
      fake.emitClose(0);

      const result = await resultPromise;
      const persisted = await fs.readFile(result.outcome.metadata.logPath, "utf8");
      const expectedOutput = "stdout: 😀\nstderr: 界\n";
      expect(updates.join("")).toBe(expectedOutput);
      expect(updates.join("")).not.toContain("�");
      expect(totals.at(-1)).toBe(Buffer.byteLength(expectedOutput));
      expect(result.rawOutput).toBe(expectedOutput);
      expect(persisted).toContain("😀");
      expect(persisted).toContain("界");
      expect(persisted).not.toContain("binary output omitted");
      expect(persisted).not.toContain("�");
    });

    it("omits malformed non-NUL UTF-8 from returned output and the persisted log", async () => {
      const fake = createFakeChild(2_000_000_044);
      const resultPromise = foregroundExecution(fake);
      await fake.ready();

      fake.stdout.write("safe prefix\n");
      fake.stdout.write(Buffer.from([0xe2]));
      fake.stdout.write(Buffer.from([0x28, 0xa1]));
      fake.stderr.write("safe stderr\n");
      fake.emitClose(0);

      const result = await resultPromise;
      const persisted = await fs.readFile(result.outcome.metadata.logPath, "utf8");
      expect(result.rawOutput).toContain("safe prefix");
      expect(result.rawOutput).toContain("[stdout binary output omitted: 3 bytes]");
      expect(result.rawOutput).toContain("safe stderr");
      expect(result.rawOutput).not.toContain("�");
      expect(persisted).toContain("[stdout] safe prefix");
      expect(persisted).toContain("[stdout] [stdout binary output omitted: 3 bytes]");
      expect(persisted).toContain("[stderr] safe stderr");
      expect(persisted).not.toContain("�");
    });

    it("returns exactly the final 100 lines after a high-volume timeout", async () => {
      vi.useFakeTimers();
      const fake = createFakeChild(2_000_000_040);
      const lines = Array.from({ length: 140 }, (_, index) => `timeout-line-${index}\n`);
      const resultPromise = foregroundExecution(fake, {
        timeoutMs: 100,
        cleanupProcessTree: async () => {},
      });
      await fake.ready();
      fake.stdout.write(lines.join(""));

      await vi.advanceTimersByTimeAsync(1_100);

      const result = await resultPromise;
      expect(result.outcome.reason).toBe("timedOut");
      expect(result.rawOutput).toBe(lines.slice(-BOUNDED_OUTPUT_MAX_LINES).join(""));
      expect(result.rawOutput.split("\n").filter(Boolean)).toHaveLength(BOUNDED_OUTPUT_MAX_LINES);
      expect(result.outputCapped).toBe(true);
    });

    it("preserves a non-newline-terminated final line", async () => {
      const fake = createFakeChild(2_000_000_041);
      const resultPromise = foregroundExecution(fake);
      await fake.ready();
      fake.stdout.write("complete\nfinal partial 😀");
      fake.emitClose(0);

      const result = await resultPromise;
      expect(result.rawOutput).toBe("complete\nfinal partial 😀");
      expect(result.rawOutput.endsWith("\n")).toBe(false);
    });

    it("bounds more than 10 MiB of text while keeping the latest output", async () => {
      const fake = createFakeChild(2_000_000_042);
      const logStream = new Writable({
        highWaterMark: BOUNDED_OUTPUT_MAX_BYTES + 1024 * 1024,
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const resultPromise = foregroundExecution(fake, {
        processManager: testProcessManager(() => logStream),
      });
      await fake.ready();
      fake.stdout.write("a".repeat(BOUNDED_OUTPUT_MAX_BYTES + 1_024));
      fake.stderr.write("latest-output-界\n");
      fake.emitClose(0);

      const result = await resultPromise;
      expect(Buffer.byteLength(result.rawOutput, "utf8")).toBeLessThanOrEqual(
        BOUNDED_OUTPUT_MAX_BYTES,
      );
      expect(result.rawOutput.endsWith("latest-output-界\n")).toBe(true);
      expect(result.rawOutput).not.toContain("�");
      expect(result.outputCapped).toBe(true);
    });

    it("summarizes binary streams without corrupting the result or persisted text log", async () => {
      const fake = createFakeChild(2_000_000_043);
      const resultPromise = foregroundExecution(fake);
      await fake.ready();
      fake.stdout.write(Buffer.from([0x41, 0x00, 0x42, 0x43]));
      fake.stdout.write(Buffer.from([0x01, 0x02, 0x03]));
      fake.stderr.write("safe text\n");
      fake.emitClose(0);

      const result = await resultPromise;
      const persisted = await fs.readFile(result.outcome.metadata.logPath, "utf8");
      expect(result.rawOutput).toContain("[stdout binary output omitted: 7 bytes]");
      expect(result.rawOutput).toContain("safe text");
      expect(result.rawOutput).not.toContain("\0");
      expect(result.rawOutput).not.toContain("�");
      expect(persisted).toContain("[stdout] [stdout binary output omitted: 7 bytes]");
      expect(persisted).toContain("[stderr] safe text");
      expect(persisted).not.toContain("\0");
      expect(persisted).not.toContain("�");
    });

    it("converts a synchronous spawn throw into a spawn error outcome", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(50_000);
      const error = new Error("spawn threw");
      const logStream = new PassThrough();
      const endLog = vi.spyOn(logStream, "end");
      const execution = executeForegroundCommand({
        command: "fixture command",
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        ops: {
          ...localOperations,
          process: {
            ...localOperations.process,
            spawn: () => {
              throw error;
            },
          },
        },
        processManager: testProcessManager(() => logStream),
      });

      expect((await execution).outcome).toEqual({
        reason: "spawnError",
        exitCode: null,
        signal: null,
        metadata: expectedForegroundMetadata(50_000, null),
        elapsedMs: 0,
        error,
      });
      expect(endLog).toHaveBeenCalledOnce();
    });

    it("records abort before close and settles exactly once", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(60_000);
      const controller = new AbortController();
      const fake = createFakeChild(2_000_000_005);
      const resultPromise = foregroundExecution(fake, { signal: controller.signal });
      await fake.ready();
      let fulfillmentCount = 0;
      void resultPromise.then(() => fulfillmentCount++);
      controller.abort();
      vi.advanceTimersByTime(30);
      fake.emitClose(null, "SIGTERM");
      fake.emitClose(0);
      fake.emitError(new Error("later error"));

      const { outcome } = await resultPromise;
      await Promise.resolve();
      expect(outcome).toEqual({
        reason: "aborted",
        exitCode: null,
        signal: "SIGTERM",
        metadata: expectedForegroundMetadata(60_000, 2_000_000_005),
        elapsedMs: 30,
        error: null,
      });
      expect(fulfillmentCount).toBe(1);
    });

    it("settles a no-close child after the fixed cleanup grace", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(70_000);
      const fake = createFakeChild(2_000_000_006);
      const resultPromise = foregroundExecution(fake, { timeoutMs: 1_250 });
      await fake.ready();
      let fulfillmentCount = 0;
      let fulfilled = false;
      void resultPromise.then(() => {
        fulfillmentCount++;
        fulfilled = true;
      });

      await vi.advanceTimersByTimeAsync(2_249);
      expect(fulfilled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const { outcome } = await resultPromise;
      expect(outcome).toEqual({
        reason: "timedOut",
        exitCode: null,
        signal: null,
        metadata: expectedForegroundMetadata(70_000, 2_000_000_006, 1_250),
        elapsedMs: 2_250,
        error: null,
      });
      expect(fulfillmentCount).toBe(1);
    });

    it("settles at deadline plus fixed grace while process-tree cleanup is still pending", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(75_000);
      const fake = createFakeChild(2_000_000_013);
      let finishCleanup: (() => void) | undefined;
      const cleanup = vi.fn(
        (_target: ProcessTarget) =>
          new Promise<void>((resolve) => {
            finishCleanup = resolve;
          }),
      );
      const resultPromise = foregroundExecution(fake, {
        timeoutMs: 400,
        cleanupProcessTree: cleanup,
      });
      await fake.ready();
      let fulfilled = false;
      void resultPromise.then(() => {
        fulfilled = true;
      });

      await vi.advanceTimersByTimeAsync(400);
      expect(cleanup).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 2_000_000_013, isExited: expect.any(Function) }),
      );
      const [target] = cleanup.mock.calls[0] as [ProcessTarget];
      expect(target.isExited?.()).toBe(false);
      expect(finishCleanup).toBeTypeOf("function");
      await vi.advanceTimersByTimeAsync(999);
      expect(fulfilled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const { outcome } = await resultPromise;
      expect(outcome.reason).toBe("timedOut");
      expect(outcome.elapsedMs).toBe(1_400);
      expect(finishCleanup).toBeTypeOf("function");
      finishCleanup?.();
    });

    it("keeps timeout classification and close metadata during cleanup grace", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(80_000);
      const fake = createFakeChild(2_000_000_009);
      const resultPromise = foregroundExecution(fake, { timeoutMs: 300 });
      await fake.ready();
      let fulfillmentCount = 0;
      void resultPromise.then(() => fulfillmentCount++);

      await vi.advanceTimersByTimeAsync(300);
      vi.advanceTimersByTime(40);
      fake.emitClose(null, "SIGKILL");
      fake.emitClose(0);
      fake.emitError(new Error("later error"));

      expect((await resultPromise).outcome).toEqual({
        reason: "timedOut",
        exitCode: null,
        signal: "SIGKILL",
        metadata: expectedForegroundMetadata(80_000, 2_000_000_009, 300),
        elapsedMs: 340,
        error: null,
      });
      await Promise.resolve();
      expect(fulfillmentCount).toBe(1);
    });

    it("claims an explicit timeout at its exact configured deadline", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(90_000);
      const fake = createFakeChild(2_000_000_010);
      const resultPromise = foregroundExecution(fake, { timeoutMs: 250 });
      await fake.ready();
      let fulfilled = false;
      void resultPromise.then(() => {
        fulfilled = true;
      });

      await vi.advanceTimersByTimeAsync(1_249);
      expect(fulfilled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const { outcome } = await resultPromise;
      expect(outcome.reason).toBe("timedOut");
      expect(outcome.elapsedMs).toBe(1_250);
    });

    it.each(["completed", "timedOut", "aborted", "spawnError"] as const)(
      "returns every %s foreground resource to its listener and timer baseline",
      async (path) => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const fake = createFakeChild();
        const baseline = foregroundResourceCounts(fake, controller.signal);
        const resultPromise = foregroundExecution(fake, {
          timeoutMs: 200,
          signal: controller.signal,
          cleanupProcessTree: async () => {},
        });
        await fake.ready();

        if (path === "completed") fake.emitClose(0);
        if (path === "spawnError") fake.emitError(new Error("spawn failed"));
        if (path === "timedOut") await vi.advanceTimersByTimeAsync(1_200);
        if (path === "aborted") {
          controller.abort();
          await vi.advanceTimersByTimeAsync(1_000);
        }

        expect((await resultPromise).outcome.reason).toBe(path);
        expect(foregroundResourceCounts(fake, controller.signal)).toEqual(baseline);
      },
    );

    it("ignores an abort dispatched after completed settlement", async () => {
      const controller = new AbortController();
      const fake = createFakeChild(2_000_000_015);
      const cleanupProcessTree = vi.fn(async () => {});
      const reapProcessWrapper = vi.fn();
      const resultPromise = foregroundExecution(fake, {
        signal: controller.signal,
        cleanupProcessTree,
        reapProcessWrapper,
      });
      await fake.ready();

      fake.emitClose(0);
      await expect(resultPromise).resolves.toMatchObject({ outcome: { reason: "completed" } });
      controller.abort();
      await Promise.resolve();

      expect(reapProcessWrapper).toHaveBeenCalledOnce();
      expect(cleanupProcessTree).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    });

    it("logs rejected cleanup without changing the selected abort result", async () => {
      vi.useFakeTimers();
      const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
      const controller = new AbortController();
      const fake = createFakeChild(2_000_000_014);
      const resultPromise = foregroundExecution(fake, {
        signal: controller.signal,
        cleanupProcessTree: async () => {
          throw new Error("cleanup rejected");
        },
      });
      await fake.ready();

      controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);

      expect((await resultPromise).outcome.reason).toBe("aborted");
      expect(warning).toHaveBeenCalledWith(
        "WARN",
        "bash",
        "Foreground process-tree cleanup failed",
        expect.objectContaining({ pid: "2000000014", error: "cleanup rejected" }),
      );
    });

    it("waits for delayed foreground log flush before returning", async () => {
      const fake = createFakeChild(2_000_000_031);
      const persistedChunks: Buffer[] = [];
      let finishFlush: (() => void) | undefined;
      const logStream = new Writable({
        write(chunk, _encoding, callback) {
          persistedChunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          finishFlush = callback;
        },
      });
      const resultPromise = foregroundExecution(fake, {
        processManager: testProcessManager(() => logStream),
      });
      await fake.ready();
      let fulfilled = false;
      void resultPromise.then(() => {
        fulfilled = true;
      });

      fake.stdout.write("final output\n");
      fake.emitClose(0);
      await Promise.resolve();
      expect(fulfilled).toBe(false);
      expect(Buffer.concat(persistedChunks).toString("utf8")).toContain("[stdout] final output");

      finishFlush?.();
      await expect(resultPromise).resolves.toMatchObject({ outcome: { reason: "completed" } });
    });

    it("reports a log error emitted while closing without changing the outcome", async () => {
      const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
      const fake = createFakeChild(2_000_000_032);
      const closeError = new Error("foreground flush failed");
      const logStream = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
        final(callback) {
          callback(closeError);
        },
      });
      const resultPromise = foregroundExecution(fake, {
        processManager: testProcessManager(() => logStream),
      });
      await fake.ready();

      fake.emitClose(7);

      await expect(resultPromise).resolves.toMatchObject({ outcome: { reason: "nonZeroExit" } });
      expect(warning).toHaveBeenCalledWith(
        "WARN",
        "bash",
        "Foreground log stream failed",
        expect.objectContaining({ error: closeError.message }),
      );
    });

    it.each([
      ["completed", "completed"],
      ["nonZeroExit", "nonZeroExit"],
      ["emittedSpawnError", "spawnError"],
      ["aborted", "aborted"],
      ["timedOutWithClose", "timedOut"],
      ["timedOutWithoutClose", "timedOut"],
    ] as const)("closes the log exactly once for %s", async (scenario, expectedReason) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const fake = createFakeChild(2_000_000_030);
      const controller = new AbortController();
      const logStream = new PassThrough();
      const endLog = vi.spyOn(logStream, "end");
      const manager = testProcessManager(() => logStream);
      const execution = foregroundExecution(fake, {
        timeoutMs: 100,
        signal: controller.signal,
        processManager: manager,
      });
      await fake.ready();

      if (scenario === "completed") fake.emitClose(0);
      if (scenario === "nonZeroExit") fake.emitClose(7);
      if (scenario === "emittedSpawnError") fake.emitError(new Error("missing"));
      if (scenario === "aborted") {
        controller.abort();
        fake.emitClose(null, "SIGTERM");
      }
      if (scenario === "timedOutWithClose") {
        await vi.advanceTimersByTimeAsync(100);
        fake.emitClose(null, "SIGTERM");
      }
      if (scenario === "timedOutWithoutClose") {
        await vi.advanceTimersByTimeAsync(1_100);
      }

      const result = await execution;
      expect(result.outcome.reason).toBe(expectedReason);
      expect(result.outcome.metadata).toEqual(expectedForegroundMetadata(0, 2_000_000_030, 100));
      await expect(fs.stat(result.outcome.metadata.logPath)).resolves.toBeDefined();
      expect(endLog).toHaveBeenCalledOnce();
    });
  });

  describe("detached foreground descendants", () => {
    const detachedReadinessTimeoutMs = 10_000;
    const detachedLifecycleTimeoutMs = detachedReadinessTimeoutMs + 5_000;

    async function prepareDetachedRun(mode: "exit" | "hold") {
      const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-detached-foreground-"));
      const evidenceFile = path.join(tempDirectory, "evidence.jsonl");
      const readinessFile = path.join(tempDirectory, "worker.ready");
      const { isCmdFallback } = resolveShell("");
      const command = [
        process.execPath,
        fixturePath("bash-detached-launcher.mjs"),
        evidenceFile,
        fixturePath("bash-detached-worker.mjs"),
        readinessFile,
        mode,
      ]
        .map((value) => quotePathForShell(value, isCmdFallback))
        .join(" ");
      return { tempDirectory, evidenceFile, command };
    }

    it("leaves an intentionally detached worker alive after normal completion", async () => {
      const fixture = await prepareDetachedRun("exit");
      try {
        const result = await executeForegroundCommand({
          command: fixture.command,
          cwd: process.cwd(),
          timeoutMs: detachedLifecycleTimeoutMs,
          signal: new AbortController().signal,
          ops: localOperations,
          processManager: testProcessManager(),
        });
        const roles = await waitForFixtureRoles(fixture.evidenceFile, [
          "detached-launcher",
          "detached-worker",
        ]);
        const worker = roles.find(({ role }) => role === "detached-worker");

        expect(result.outcome.reason).toBe("completed");
        expect(worker?.pid).toBeGreaterThan(0);
        expect(worker && isAlive(worker.pid)).toBe(true);
      } finally {
        await cleanupRecordedPids(fixture.evidenceFile);
        await fs.rm(fixture.tempDirectory, { recursive: true, force: true });
      }
    }, 25_000);

    it("removes a TERM-ignoring detached worker after the TERM-killed root exits", async () => {
      const fixture = await prepareDetachedRun("hold");
      const timeoutMs = detachedLifecycleTimeoutMs;
      try {
        const execution = executeForegroundCommand({
          command: fixture.command,
          cwd: process.cwd(),
          timeoutMs,
          signal: new AbortController().signal,
          ops: localOperations,
          processManager: testProcessManager(),
        });
        const roles = await waitForFixtureRoles(
          fixture.evidenceFile,
          ["detached-launcher", "detached-worker"],
          detachedReadinessTimeoutMs,
        );

        const result = await execution;
        expect(result.outcome.reason).toBe("timedOut");
        expect(result.outcome.elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 100);
        if (process.platform !== "win32") expect(result.outcome.signal).toBe("SIGTERM");
        await waitForRecordedPidsToExit(roles);
      } finally {
        await cleanupRecordedPids(fixture.evidenceFile);
        await fs.rm(fixture.tempDirectory, { recursive: true, force: true });
      }
    }, 30_000);

    it("removes the launcher and detached worker after AbortSignal cancellation", async () => {
      const fixture = await prepareDetachedRun("hold");
      const controller = new AbortController();
      try {
        const execution = executeForegroundCommand({
          command: fixture.command,
          cwd: process.cwd(),
          timeoutMs: detachedLifecycleTimeoutMs,
          signal: controller.signal,
          ops: localOperations,
          processManager: testProcessManager(),
        });
        const roles = await waitForFixtureRoles(
          fixture.evidenceFile,
          ["detached-launcher", "detached-worker"],
          detachedReadinessTimeoutMs,
        );
        controller.abort();

        expect((await execution).outcome.reason).toBe("aborted");
        await waitForRecordedPidsToExit(roles);
      } finally {
        controller.abort();
        await cleanupRecordedPids(fixture.evidenceFile);
        await fs.rm(fixture.tempDirectory, { recursive: true, force: true });
      }
    }, 25_000);
  });

  describe("foreground result rendering", () => {
    it("keeps numeric non-zero rendering", async () => {
      const fake = createFakeChild();
      const resultPromise = executeRendered(fake);
      await fake.ready();
      fake.emitClose(7);
      const result = await resultPromise;
      expect(result).toContain("Exit code: 7");
      expectRenderedDiagnostics(result, "nonZeroExit");
    });

    it("returns typed foreground diagnostics in structured result details", async () => {
      const fake = createFakeChild(2_000_000_014);
      const tool = createBashTool(process.cwd(), testProcessManager(), operationsFor(fake.child));
      const resultPromise = tool.execute(
        { command: "fixture command", timeout: 1_750 },
        { signal: new AbortController().signal, toolCallId: "bash-details" },
      );
      await fake.ready();
      const normalOutput = "normal-output-界\n";
      fake.stdout.write(normalOutput);
      fake.emitClose(0);

      const result = await resultPromise;
      if (typeof result === "string") throw new Error("Expected structured bash output");
      expect(result.details).toEqual({
        bashDiagnostics: {
          executionId: expect.any(String),
          pid: 2_000_000_014,
          command: "fixture command",
          cwd: process.cwd(),
          startedAt: expect.any(Number),
          timeoutMs: 1_750,
          reason: "completed",
          exitCode: 0,
          signal: null,
          elapsedMs: expect.any(Number),
          logPath: expect.stringContaining(FOREGROUND_TEST_LOG_ROOT),
          tail: normalOutput,
          outputCapped: false,
          totalOutputBytes: Buffer.byteLength(normalOutput),
          retainedOutputBytes: Buffer.byteLength(normalOutput),
          droppedOutputBytes: 0,
        },
      });
    });

    it("reports capped output byte counts without changing rendered result text", async () => {
      const fake = createFakeChild(2_000_000_051);
      const tool = createBashTool(process.cwd(), testProcessManager(), operationsFor(fake.child));
      const resultPromise = tool.execute(
        { command: "fixture command" },
        { signal: new AbortController().signal, toolCallId: "bash-capped-details" },
      );
      await fake.ready();
      const lines = Array.from({ length: 140 }, (_, index) => `capped-line-${index}\n`);
      const completeOutput = lines.join("");
      const retainedOutput = lines.slice(-BOUNDED_OUTPUT_MAX_LINES).join("");
      fake.stdout.write(completeOutput);
      fake.emitClose(0);

      const result = await resultPromise;
      if (typeof result === "string" || typeof result.content !== "string") {
        throw new Error("Expected structured text bash output");
      }
      expect(result.details).toMatchObject({
        bashDiagnostics: {
          tail: retainedOutput,
          outputCapped: true,
          totalOutputBytes: Buffer.byteLength(completeOutput),
          retainedOutputBytes: Buffer.byteLength(retainedOutput),
          droppedOutputBytes: Buffer.byteLength(completeOutput) - Buffer.byteLength(retainedOutput),
        },
      });
      expect(result.content).toContain("Exit code: 0\n");
      expect(result.content).toContain(
        `[Foreground output tail capped at ${BOUNDED_OUTPUT_MAX_LINES} lines / 10 MB.`,
      );
      expect(result.content).not.toContain("Total output bytes:");
      expectRenderedDiagnostics(result.content, "completed");
    });

    it.each([
      ["non-zero", "nonZeroExit", 7, null],
      ["signal", "nonZeroExit", null, "SIGTERM"],
      ["abort", "aborted", null, "SIGTERM"],
      ["timeout-with-close", "timedOut", null, "SIGKILL"],
      ["timeout-without-close", "timedOut", null, null],
      ["spawn-error", "spawnError", null, null],
    ] as const)(
      "serializes exit code, signal, and tail for %s",
      async (scenario, reason, expectedExitCode, expectedSignal) => {
        if (scenario.startsWith("timeout")) vi.useFakeTimers();
        const controller = new AbortController();
        const fake = createFakeChild(2_000_000_050);
        const ops = operationsFor(fake.child);
        ops.process = { ...ops.process, cleanupProcessTree: async () => {} };
        const tool = createBashTool(process.cwd(), testProcessManager(), ops);
        const resultPromise = tool.execute(
          { command: "fixture command", timeout: 1_000 },
          { signal: controller.signal, toolCallId: `bash-details-${scenario}` },
        );
        await fake.ready();
        fake.stdout.write(`${scenario}-tail`);

        if (scenario === "non-zero") fake.emitClose(7);
        if (scenario === "signal") fake.emitClose(null, "SIGTERM");
        if (scenario === "abort") {
          controller.abort();
          fake.emitClose(null, "SIGTERM");
        }
        if (scenario === "timeout-with-close") {
          await vi.advanceTimersByTimeAsync(1_000);
          fake.emitClose(null, "SIGKILL");
        }
        if (scenario === "timeout-without-close") {
          await vi.advanceTimersByTimeAsync(2_000);
        }
        if (scenario === "spawn-error") fake.emitError(new Error("spawn failed"));

        const result = await resultPromise;
        if (typeof result === "string") throw new Error("Expected structured bash output");
        expect(result.details).toMatchObject({
          bashDiagnostics: {
            reason,
            exitCode: expectedExitCode,
            signal: expectedSignal,
            tail: `${scenario}-tail`,
          },
        });
      },
    );

    it("renders signal-only termination without inventing code 1", async () => {
      const fake = createFakeChild();
      const resultPromise = executeRendered(fake);
      await fake.ready();
      fake.emitClose(null, "SIGTERM");
      const result = await resultPromise;
      expect(result).toContain("Exit code: SIGNAL (SIGTERM)");
      expectRenderedDiagnostics(result, "nonZeroExit");
    });

    it("renders abort distinctly", async () => {
      const controller = new AbortController();
      const fake = createFakeChild();
      const resultPromise = executeRendered(fake, { signal: controller.signal });
      await fake.ready();
      controller.abort();
      fake.emitClose(null, "SIGTERM");
      const result = await resultPromise;
      expect(result).toContain("Exit code: ABORTED");
      expectRenderedDiagnostics(result, "aborted");
    });

    it("renders configured timeout without a child close event", async () => {
      vi.useFakeTimers();
      const fake = createFakeChild();
      const resultPromise = executeRendered(fake, { timeoutMs: 1_750 });
      await fake.ready();

      await vi.advanceTimersByTimeAsync(2_750);

      const result = await resultPromise;
      expect(result).toContain("Exit code: TIMEOUT (1750ms)");
      expectRenderedDiagnostics(result, "timedOut");
    });

    it("keeps the omitted timeout deadline at exactly 120000ms", async () => {
      vi.useFakeTimers();
      const fake = createFakeChild(2_000_000_012);
      const resultPromise = executeRendered(fake);
      await fake.ready();
      let fulfilled = false;
      void resultPromise.then(() => {
        fulfilled = true;
      });

      await vi.advanceTimersByTimeAsync(120_999);
      expect(fulfilled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const result = await resultPromise;
      expect(result).toContain("Exit code: TIMEOUT (120000ms)");
      expectRenderedDiagnostics(result, "timedOut");
    });

    it("keeps the friendly emitted spawn failure message", async () => {
      const fake = createFakeChild();
      const resultPromise = executeRendered(fake);
      await fake.ready();
      fake.emitError(new Error("not found"));
      fake.emitClose(1);
      const result = await resultPromise;
      expect(result).toContain("Exit code: 1\nFailed to spawn: not found");
      expectRenderedDiagnostics(result, "spawnError");
    });

    it("keeps the friendly synchronous spawn failure message", async () => {
      const tool = createBashTool(process.cwd(), testProcessManager(), {
        ...localOperations,
        process: {
          ...localOperations.process,
          spawn: () => {
            throw new Error("sync not found");
          },
        },
      });
      const result = await tool.execute(
        { command: "fixture command" },
        { signal: new AbortController().signal, toolCallId: "bash-sync-spawn" },
      );
      if (typeof result === "string" || typeof result.content !== "string") {
        throw new Error("Expected structured text bash output");
      }
      expect(result.content).toContain("Exit code: 1\nFailed to spawn: sync not found");
      expect(result.content).toContain("PID: unavailable");
      expect(result.details).toMatchObject({
        bashDiagnostics: {
          pid: null,
          reason: "spawnError",
          exitCode: null,
          signal: null,
          tail: "",
        },
      });
      expectRenderedDiagnostics(result.content, "spawnError");
    });
  });

  it("kills the persistent session shell when its process manager shuts down", async () => {
    const manager = testProcessManager();
    const tool = createBashTool(process.cwd(), manager);
    let shellPid: number | null = null;

    try {
      const rawResult = await tool.execute(
        { command: "printf 'managed-shell\\n'", persist: true },
        { signal: new AbortController().signal, toolCallId: "bash-persistent-shutdown" },
      );
      const diagnostics = structuredBashResult(rawResult).details.bashDiagnostics;
      shellPid = diagnostics.pid;
      expect(shellPid).toEqual(expect.any(Number));
      if (shellPid === null) throw new Error("Persistent shell did not expose a PID");
      expect(isAlive(shellPid)).toBe(true);

      manager.shutdownAll();
      await waitForRecordedPidsToExit([
        { role: "persistent-shell", pid: shellPid, ppid: process.pid },
      ]);
      manager.shutdownAll();
      expect(isAlive(shellPid)).toBe(false);
    } finally {
      manager.shutdownAll();
      if (shellPid !== null && isAlive(shellPid)) terminateSupervisedTree(shellPid);
    }
  });

  it("returns complete persistent completion and non-zero diagnostics while preserving state", async () => {
    const manager = testProcessManager();
    const tool = createBashTool(process.cwd(), manager);

    try {
      const completedRaw = await tool.execute(
        {
          command: "export GG_PERSIST_VALUE=kept; printf 'persistent-set\\n'",
          persist: true,
        },
        { signal: new AbortController().signal, toolCallId: "bash-persistent-completed" },
      );
      const completed = structuredBashResult(completedRaw);
      const completedDiagnostics = completed.details.bashDiagnostics;
      expectCompletePersistentDiagnostics(completedDiagnostics, {
        command: "export GG_PERSIST_VALUE=kept; printf 'persistent-set\\n'",
        reason: "completed",
        exitCode: 0,
        tail: "persistent-set\n",
        outputCapped: false,
        totalOutputBytes: Buffer.byteLength("persistent-set\n"),
        retainedOutputBytes: Buffer.byteLength("persistent-set\n"),
        droppedOutputBytes: 0,
      });
      expect(completed.content).toContain("Exit code: 0\npersistent-set\n");
      expect(await fs.readFile(completedDiagnostics.logPath, "utf8")).toBe(
        "[stdout] persistent-set\n",
      );

      const nonZeroRaw = await tool.execute(
        { command: `printf 'STATE=%s\\n' "$GG_PERSIST_VALUE"; false`, persist: true },
        { signal: new AbortController().signal, toolCallId: "bash-persistent-non-zero" },
      );
      const nonZero = structuredBashResult(nonZeroRaw);
      expectCompletePersistentDiagnostics(nonZero.details.bashDiagnostics, {
        command: `printf 'STATE=%s\\n' "$GG_PERSIST_VALUE"; false`,
        pid: completedDiagnostics.pid,
        reason: "nonZeroExit",
        exitCode: 1,
        tail: "STATE=kept\n",
        outputCapped: false,
        totalOutputBytes: Buffer.byteLength("STATE=kept\n"),
        retainedOutputBytes: Buffer.byteLength("STATE=kept\n"),
        droppedOutputBytes: 0,
      });
      expect(nonZero.content).toContain("Exit code: 1\nSTATE=kept\n");
      expect(nonZero.details.bashDiagnostics.executionId).not.toBe(
        completedDiagnostics.executionId,
      );
      expect(nonZero.details.bashDiagnostics.logPath).not.toBe(completedDiagnostics.logPath);
    } finally {
      await tool.execute(
        { command: "exit 0", persist: true },
        { signal: new AbortController().signal, toolCallId: "bash-persistent-complete-cleanup" },
      );
      manager.shutdownAll();
    }
  });

  it("returns complete persistent timeout diagnostics and resets shell state", async () => {
    const manager = testProcessManager();
    const tool = createBashTool(process.cwd(), manager);

    try {
      const timedOutRaw = await tool.execute(
        {
          command: "export GG_PERSIST_TIMEOUT_STATE=lost; printf 'before-timeout\\n'; sleep 30",
          timeout: 1_000,
          persist: true,
        },
        { signal: new AbortController().signal, toolCallId: "bash-persistent-timeout" },
      );
      const timedOut = structuredBashResult(timedOutRaw);
      const diagnostics = timedOut.details.bashDiagnostics;
      expect(timedOut.content).toContain(
        "Exit code: TIMEOUT (1000ms) — session shell was reset; cd/env state is gone",
      );
      expectCompletePersistentDiagnostics(diagnostics, {
        command: "export GG_PERSIST_TIMEOUT_STATE=lost; printf 'before-timeout\\n'; sleep 30",
        timeoutMs: 1_000,
        reason: "timedOut",
        exitCode: null,
        tail: "before-timeout\n",
        outputCapped: false,
        totalOutputBytes: Buffer.byteLength("before-timeout\n"),
        retainedOutputBytes: Buffer.byteLength("before-timeout\n"),
        droppedOutputBytes: 0,
      });
      expect(diagnostics.elapsedMs).toBeGreaterThanOrEqual(900);
      expect(await fs.readFile(diagnostics.logPath, "utf8")).toBe("[stdout] before-timeout\n");

      const freshRaw = await tool.execute(
        {
          command: `printf 'STATE=%s\\n' "\${GG_PERSIST_TIMEOUT_STATE:-fresh}"`,
          persist: true,
        },
        { signal: new AbortController().signal, toolCallId: "bash-persistent-after-timeout" },
      );
      const freshDiagnostics = structuredBashResult(freshRaw).details.bashDiagnostics;
      expect(freshDiagnostics.tail).toBe("STATE=fresh\n");
      expect(freshDiagnostics.pid).not.toBe(diagnostics.pid);
    } finally {
      await tool.execute(
        { command: "exit 0", persist: true },
        { signal: new AbortController().signal, toolCallId: "bash-persistent-timeout-cleanup" },
      );
      manager.shutdownAll();
    }
  });

  it("caps persistent diagnostics to the authoritative tail and retains the full log", async () => {
    const manager = testProcessManager();
    const tool = createBashTool(process.cwd(), manager);
    const lines = Array.from(
      { length: 140 },
      (_, index) => `persistent-line-${String(index + 1).padStart(3, "0")}\n`,
    );

    try {
      const rawResult = await tool.execute(
        {
          command: "for ((i=1; i<=140; i++)); do printf 'persistent-line-%03d\\n' \"$i\"; done",
          persist: true,
        },
        { signal: new AbortController().signal, toolCallId: "bash-persistent-capped" },
      );
      const result = structuredBashResult(rawResult);
      const diagnostics = result.details.bashDiagnostics;
      const completeOutput = lines.join("");
      const retainedOutput = lines.slice(-BOUNDED_OUTPUT_MAX_LINES).join("");
      expectCompletePersistentDiagnostics(diagnostics, {
        reason: "completed",
        exitCode: 0,
        tail: retainedOutput,
        outputCapped: true,
        totalOutputBytes: Buffer.byteLength(completeOutput),
        retainedOutputBytes: Buffer.byteLength(retainedOutput),
        droppedOutputBytes: Buffer.byteLength(completeOutput) - Buffer.byteLength(retainedOutput),
      });
      expect(result.content).toContain(
        `[Foreground output tail capped at ${BOUNDED_OUTPUT_MAX_LINES} lines / 10 MB.`,
      );
      const retainedLog = await fs.readFile(diagnostics.logPath, "utf8");
      expect(retainedLog).toContain(lines[0]);
      expect(retainedLog).toContain(lines.at(-1));
      expect(retainedLog).not.toContain("__GG_PSH_");
    } finally {
      await tool.execute(
        { command: "exit 0", persist: true },
        { signal: new AbortController().signal, toolCallId: "bash-persistent-capped-cleanup" },
      );
      manager.shutdownAll();
    }
  });

  it("returns complete persistent spawn-error diagnostics", async () => {
    const manager = testProcessManager();
    const tool = createBashTool(process.cwd(), manager, {
      ...localOperations,
      process: {
        ...localOperations.process,
        spawn: () => {
          throw new Error("persistent bash unavailable");
        },
      },
    });

    const rawResult = await tool.execute(
      { command: "printf 'never-ran\\n'", persist: true },
      { signal: new AbortController().signal, toolCallId: "bash-persistent-spawn-error" },
    );
    const result = structuredBashResult(rawResult);
    const diagnostics = result.details.bashDiagnostics;
    expect(Object.keys(diagnostics).sort()).toEqual(Object.keys(BASH_DIAGNOSTICS_FIXTURE).sort());
    expect(diagnostics).toMatchObject({
      pid: null,
      command: "printf 'never-ran\\n'",
      cwd: process.cwd(),
      reason: "spawnError",
      exitCode: null,
      signal: null,
      tail: "",
      outputCapped: false,
      totalOutputBytes: 0,
      retainedOutputBytes: 0,
      droppedOutputBytes: 0,
    });
    expect(result.content).toContain("Exit code: 1\nFailed to spawn: persistent bash unavailable");
    await expect(fs.readFile(diagnostics.logPath, "utf8")).resolves.toBe("");
    manager.shutdownAll();
  });

  it("returns complete persistent abort diagnostics, retains partial output, and resets state", async () => {
    const manager = testProcessManager();
    const controller = new AbortController();
    const tool = createBashTool(process.cwd(), manager);

    try {
      const rawResult = await tool.execute(
        {
          command: "export GG_PERSIST_ABORT_STATE=lost; printf 'partial-before-abort\\n'; sleep 30",
          persist: true,
        },
        {
          signal: controller.signal,
          toolCallId: "bash-persistent-abort",
          onUpdate(update) {
            if (
              typeof update === "object" &&
              update !== null &&
              "output" in update &&
              String(update.output).includes("partial-before-abort")
            ) {
              controller.abort();
            }
          },
        },
      );
      const result = structuredBashResult(rawResult);
      const diagnostics = result.details.bashDiagnostics;

      expect(result.content).toContain("Exit code: ABORTED\npartial-before-abort\n");
      expectCompletePersistentDiagnostics(diagnostics, {
        command: "export GG_PERSIST_ABORT_STATE=lost; printf 'partial-before-abort\\n'; sleep 30",
        reason: "aborted",
        exitCode: null,
        tail: "partial-before-abort\n",
        outputCapped: false,
        totalOutputBytes: Buffer.byteLength("partial-before-abort\n"),
        retainedOutputBytes: Buffer.byteLength("partial-before-abort\n"),
        droppedOutputBytes: 0,
      });
      expect(await fs.readFile(diagnostics.logPath, "utf8")).toBe(
        "[stdout] partial-before-abort\n",
      );

      const freshRawResult = await tool.execute(
        {
          command: `printf 'STATE=%s\\n' "\${GG_PERSIST_ABORT_STATE:-fresh}"`,
          persist: true,
        },
        { signal: new AbortController().signal, toolCallId: "bash-persistent-after-abort" },
      );
      const freshDiagnostics = structuredBashResult(freshRawResult).details.bashDiagnostics;
      expect(freshDiagnostics.reason).toBe("completed");
      expect(freshDiagnostics.tail).toBe("STATE=fresh\n");
      expect(freshDiagnostics.pid).not.toBe(diagnostics.pid);
    } finally {
      await tool.execute(
        { command: "exit 0", persist: true },
        { signal: new AbortController().signal, toolCallId: "bash-persistent-abort-cleanup" },
      );
      manager.shutdownAll();
    }
  });

  it("excludes the private sentinel from persistent progress byte counts", async () => {
    const fake = createPersistentFakeChild();
    const stdin = fake.child.stdin as PassThrough;
    const stdout = fake.child.stdout as PassThrough;
    const updates: Array<{ text: string; totalBytes: number }> = [];

    stdin.once("data", (data: Buffer) => {
      const sentinel = /echo "(__GG_PSH_[^"]+__)\$\?"/.exec(data.toString("utf8"))?.[1];
      if (!sentinel) throw new Error("Expected persistent-shell sentinel");
      const splitAt = Math.floor(sentinel.length / 2);
      stdout.write(Buffer.from(`visible\n${sentinel.slice(0, splitAt)}`));
      stdout.write(Buffer.from(`${sentinel.slice(splitAt)}0\n`));
    });

    const shell = new PersistentShell(process.cwd(), process.env, 1024, {
      ...localOperations.process,
      spawn: () => fake.child,
    });
    const result = await shell.run(
      "printf 'visible\\n'",
      1_000,
      new AbortController().signal,
      (text, totalBytes) => updates.push({ text, totalBytes }),
    );

    expect(result).toMatchObject({
      reason: "completed",
      exitCode: 0,
      output: "visible\n",
      outputSnapshot: { totalInputBytes: Buffer.byteLength("visible\n") },
    });
    expect(updates).toEqual([{ text: "visible\n", totalBytes: Buffer.byteLength("visible\n") }]);
  });

  it("settles pre-aborted persistent runs as ABORTED without retaining listeners", async () => {
    const controller = new AbortController();
    controller.abort();
    const cleanup = vi.fn(async (target: ProcessTarget) => killProcessTree(target));
    const shell = new PersistentShell(process.cwd(), process.env, 1024 * 1024, {
      ...localOperations.process,
      cleanupProcessTree: cleanup,
    });

    await expect(shell.run("sleep 30", 5_000, controller.signal)).resolves.toMatchObject({
      reason: "aborted",
      exitCode: null,
      signal: null,
      output: "",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect((shell as unknown as { child: ChildProcess | null }).child).toBeNull();
    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ pid: expect.any(Number), isExited: expect.any(Function) }),
    );
  });

  it("cleans persistent-run listeners and logs rejected process cleanup", async () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const controller = new AbortController();
    const cleanup = vi.fn(async (target: ProcessTarget) => {
      killProcessTree(target);
      throw new Error("persistent cleanup rejected");
    });
    const shell = new PersistentShell(process.cwd(), process.env, 1024 * 1024, {
      ...localOperations.process,
      cleanupProcessTree: cleanup,
    });
    const runPromise = shell.run("sleep 30", 5_000, controller.signal);
    const child = (shell as unknown as { child: ChildProcess }).child;

    expect(child.listenerCount("exit")).toBe(1);
    expect(child.listenerCount("error")).toBe(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();

    await expect(runPromise).resolves.toMatchObject({
      reason: "aborted",
      exitCode: null,
      signal: null,
      output: "",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout?.listenerCount("data")).toBe(0);
    expect(child.stderr?.listenerCount("data")).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ pid: child.pid, isExited: expect.any(Function) }),
    );
    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "bash",
      "Persistent process-tree cleanup failed",
      expect.objectContaining({ error: "persistent cleanup rejected" }),
    );
  });

  it.each(["timeout", "abort", "kill"] as const)(
    "guards persistent %s cleanup when the root PID is reused after snapshot",
    async (mode) => {
      if (mode === "timeout") vi.useFakeTimers();
      const fake = createPersistentFakeChild();
      const snapshotStarted: boolean[] = [];
      const dispatchedSignals: number[] = [];
      let releaseSnapshot: (() => void) | undefined;
      const snapshotGate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      let target: ProcessTarget | undefined;
      const cleanup = vi.fn(async (processTarget: ProcessTarget) => {
        target = processTarget;
        snapshotStarted.push(processTarget.isExited?.() ?? false);
        await snapshotGate;
        if (!(processTarget.isExited?.() ?? false)) dispatchedSignals.push(processTarget.pid);
      });
      const shell = new PersistentShell(process.cwd(), process.env, 1024, {
        ...localOperations.process,
        cleanupProcessTree: cleanup,
        spawn: () => fake.child,
      });

      if (mode === "kill") {
        (shell as unknown as { ensureChild(): ChildProcess }).ensureChild();
        shell.kill();
      } else {
        const controller = new AbortController();
        const run = shell.run("sleep 30", mode === "timeout" ? 25 : 5_000, controller.signal);
        if (mode === "timeout") await vi.advanceTimersByTimeAsync(25);
        else controller.abort();
        await run;
      }
      await Promise.resolve();

      expect(cleanup).toHaveBeenCalledOnce();
      expect(target).toEqual(
        expect.objectContaining({ pid: fake.child.pid, isExited: expect.any(Function) }),
      );
      expect(snapshotStarted).toEqual([false]);
      expect(target?.isExited?.()).toBe(false);

      fake.markExited();
      expect(target?.isExited?.()).toBe(true);
      releaseSnapshot?.();
      await snapshotGate;
      await Promise.resolve();

      expect(dispatchedSignals).toEqual([]);
    },
  );

  it("returns a persistent timeout without sentinel or exit and resets shell state", async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gg persistent-timeout-"));
    const evidenceFile = path.join(tempDirectory, "silent.jsonl");
    const shell = new PersistentShell(process.cwd(), process.env, 1024 * 1024);
    const command = [
      `export GG_PERSIST_TIMEOUT_STATE=lost;`,
      quotePathForShell(process.execPath, false),
      quotePathForShell(fixturePath("bash-timeout-silent.mjs"), false),
      quotePathForShell(evidenceFile, false),
    ].join(" ");
    const timeoutMs = 5_000;
    const startedAt = Date.now();

    try {
      const timeoutPromise = shell.run(command, timeoutMs, new AbortController().signal);
      const [firstSession] = await waitForFixtureRoles(evidenceFile, ["silent"], 3_000);
      const readinessElapsedMs = Date.now() - startedAt;
      const timedOut = await timeoutPromise;
      const elapsedMs = Date.now() - startedAt;

      expect(firstSession?.role).toBe("silent");
      expect(readinessElapsedMs).toBeLessThan(timeoutMs - 1_000);
      expect(timedOut).toMatchObject({ reason: "timedOut", exitCode: null, signal: null });
      expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 100);
      expect(elapsedMs).toBeLessThan(timeoutMs + 3_000);

      const freshRun = await shell.run(
        `printf 'STATE=%s\\nSHELL_PID=%s\\n' "\${GG_PERSIST_TIMEOUT_STATE:-fresh}" "$$"`,
        2_000,
        new AbortController().signal,
      );
      expect(freshRun.exitCode).toBe(0);
      expect(freshRun.output).toContain("STATE=fresh");
      expect(freshRun.output).not.toContain(`SHELL_PID=${firstSession?.ppid}`);
    } finally {
      shell.kill();
      await cleanupRecordedPids(evidenceFile);
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }, 15_000);

  const posixIt = process.platform === "win32" ? it.skip : it;
  const windowsIt = process.platform === "win32" ? it : it.skip;

  posixIt(
    "lets a cooperative POSIX group record TERM and exit on timeout",
    async () => {
      await assertSupervisedPosixProbe("cooperative");
    },
    15_000,
  );

  posixIt(
    "escalates a TERM-ignoring POSIX group to KILL on abort",
    async () => {
      await assertSupervisedPosixProbe("ignore");
    },
    15_000,
  );

  windowsIt(
    "kills the cmd-to-package-manager descendant tree on timeout",
    async () => {
      await runWindowsPnpmTreeProbe("timeout");
    },
    15_000,
  );

  windowsIt(
    "kills the cmd-to-package-manager descendant tree on abort",
    async () => {
      await runWindowsPnpmTreeProbe("abort");
    },
    15_000,
  );

  it.each(basicProbes)(
    "bounds the %s foreground timeout probe",
    async (probe) => {
      await assertSupervisedProbe(probe);
    },
    35_000,
  );

  it("settles on its own hard deadline when termination cannot close the child", async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gg bash-supervisor-"));
    const evidenceFile = path.join(tempDirectory, "non-closing.jsonl");
    const terminationAttempts: number[] = [];
    let childPid = -1;

    try {
      const result = await superviseProbe("silent", evidenceFile, {
        deadlineMs: 100,
        postTerminationDeadlineMs: 150,
        childArguments: [
          "-e",
          'process.stdout.write("SUPERVISOR_FIXTURE_READY\\n"); setInterval(() => {}, 1_000)',
        ],
        terminate(pid) {
          terminationAttempts.push(pid);
        },
      });
      childPid = result.childPid;
      console.log(`PHASE01_EVIDENCE=${JSON.stringify(result)}`);

      expect(result.supervisorOutcome).toBe("hard_deadline");
      expect(result.outerDeadlineFired).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.outputTail).toContain("SUPERVISOR_FIXTURE_READY");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(200);
      expect(result.elapsedMs).toBeLessThan(3_000);
      expect(terminationAttempts).toEqual([result.childPid, result.childPid]);
    } finally {
      if (childPid > 0) terminateSupervisedTree(childPid);
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }, 5_000);
}
