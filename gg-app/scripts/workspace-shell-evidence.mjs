// Cross-platform Phase 00 evidence harness for repeated WorkspaceShell focused-test runs.
import { execFile, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const repoRoot = join(appDir, "..");

export const DEFAULT_RUNS = 3;
export const DEFAULT_DEADLINE_MS = 120_000;
export const DEFAULT_TAIL_BYTES = 32 * 1024;
export const DEFAULT_SAMPLE_MS = 200;
const DEFAULT_CLEANUP_GRACE_MS = 2_000;

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export class BoundedTail {
  constructor(maxBytes = DEFAULT_TAIL_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1)
      throw new Error("maxBytes must be a positive integer");
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
    this.totalBytes = 0;
  }

  append(chunk) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += next.length;
    this.buffer = Buffer.concat([this.buffer, next]).subarray(-this.maxBytes);
  }

  snapshot() {
    return {
      text: this.buffer.toString("utf8"),
      bytes: this.buffer.length,
      truncated: this.totalBytes > this.buffer.length,
    };
  }
}

export function processTreeSnapshot(processes, rootPid) {
  const byParent = new Map();
  for (const processInfo of processes) {
    const children = byParent.get(processInfo.ppid) ?? [];
    children.push(processInfo);
    byParent.set(processInfo.ppid, children);
  }

  const root = processes.find((processInfo) => processInfo.pid === rootPid);
  if (!root) return { pids: [], identities: [], rssBytes: 0 };

  const pending = [root];
  const seen = new Set();
  const identities = [];
  let rssBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current.pid)) continue;
    seen.add(current.pid);
    identities.push({ pid: current.pid, startedAtMs: current.startedAtMs ?? null });
    rssBytes += Math.max(0, current.rssBytes);
    const children = (byParent.get(current.pid) ?? []).filter(
      (child) =>
        current.startedAtMs === undefined ||
        child.startedAtMs === undefined ||
        child.startedAtMs >= current.startedAtMs,
    );
    pending.push(...children);
  }

  return { pids: [...seen], identities, rssBytes };
}

export function survivingProcessIds(observedIdentities, liveProcesses) {
  const liveByPid = new Map(liveProcesses.map((processInfo) => [processInfo.pid, processInfo]));
  return observedIdentities
    .filter(({ pid, startedAtMs }) => {
      const live = liveByPid.get(pid);
      if (!live) return false;
      return (
        startedAtMs === null || live.startedAtMs === undefined || live.startedAtMs === startedAtMs
      );
    })
    .map(({ pid }) => pid);
}

function parsePosixProcessTable(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      startedAtMs: Date.parse(match[4]),
    }))
    .filter((processInfo) => Number.isFinite(processInfo.startedAtMs));
}

function parseWindowsProcessTable(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\d+)\|(\d+)\|(\d+)\|(\d+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]),
      startedAtMs: Number(match[4]),
    }));
}

export async function readProcessTable(platform = process.platform) {
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Get-CimInstance Win32_Process | ForEach-Object {",
      "  $started = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()",
      "  Write-Output ($_.ProcessId.ToString() + '|' + $_.ParentProcessId.ToString() + '|' + $_.WorkingSetSize.ToString() + '|' + $started.ToString())",
      "}",
    ].join("; ");
    return parseWindowsProcessTable(
      await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]),
    );
  }

  return parsePosixProcessTable(await execFileText("ps", ["-axo", "pid=,ppid=,rss=,lstart="]));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function settleWithin(promise, milliseconds) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

async function pidExists(pid, processTableReader) {
  try {
    const processes = await processTableReader();
    return processes.some((processInfo) => processInfo.pid === pid);
  } catch {
    return true;
  }
}

export async function terminateProcessTree(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  const processTableReader = options.processTableReader ?? (() => readProcessTable(platform));
  if (platform === "win32") {
    try {
      await execFileText("taskkill.exe", ["/pid", String(pid), "/t", "/f"]);
    } catch {
      // An already-exited tree is the desired state.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await wait(250);
  if (!(await pidExists(pid, processTableReader))) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process exited between the liveness check and kill.
    }
  }
}

export async function runSupervisedProcess(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const sampleMs = options.sampleMs ?? DEFAULT_SAMPLE_MS;
  const cleanupGraceMs = options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
  const survivorSettleMs = options.survivorSettleMs ?? 1_000;
  const processTableReader = options.processTableReader ?? (() => readProcessTable(platform));
  const terminate =
    options.terminate ?? ((pid) => terminateProcessTree(pid, { platform, processTableReader }));
  const output = new BoundedTail(options.tailBytes ?? DEFAULT_TAIL_BYTES);
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + deadlineMs;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: platform !== "win32",
    shell: options.shell ?? false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let spawnError = null;
  let exitCode = null;
  let signal = null;
  let timedOut = false;
  let timeoutTriggeredAtMs = null;
  let terminationRequestedAtMs = null;
  let terminationCompletedAtMs = null;
  let processClosedAtMs = null;
  let terminationError = null;
  let peakTreeRssBytes = 0;
  let samplingPromise = null;
  let terminationPromise = null;
  const processInspectionErrors = [];
  const observedProcesses = new Map();
  if (child.pid) observedProcesses.set(child.pid, null);

  child.stdout?.on("data", (chunk) => output.append(chunk));
  child.stderr?.on("data", (chunk) => output.append(chunk));

  const closed = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
      resolve();
    });
    child.once("close", (code, closeSignal) => {
      processClosedAtMs = Date.now();
      exitCode = code;
      signal = closeSignal;
      resolve();
    });
  });

  const sample = () => {
    if (!child.pid) return Promise.resolve();
    if (samplingPromise) return samplingPromise;
    samplingPromise = (async () => {
      try {
        const tree = processTreeSnapshot(await processTableReader(), child.pid);
        peakTreeRssBytes = Math.max(peakTreeRssBytes, tree.rssBytes);
        for (const identity of tree.identities) {
          observedProcesses.set(identity.pid, identity.startedAtMs);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        processInspectionErrors.push(message);
        output.append(`\n[supervisor sample failed: ${message}]\n`);
      } finally {
        samplingPromise = null;
      }
    })();
    return samplingPromise;
  };
  const requestTermination = () => {
    if (!child.pid) return Promise.resolve();
    if (!terminationPromise) {
      terminationRequestedAtMs = Date.now();
      terminationPromise = Promise.resolve()
        .then(() => terminate(child.pid))
        .catch((error) => {
          terminationError = error instanceof Error ? error.message : String(error);
          output.append(`\n[supervisor termination failed: ${terminationError}]\n`);
        })
        .finally(() => {
          terminationCompletedAtMs = Date.now();
        });
    }
    return terminationPromise;
  };

  const sampler = setInterval(() => void sample(), sampleMs);
  const deadline = setTimeout(() => {
    timedOut = true;
    timeoutTriggeredAtMs = Date.now();
    void requestTermination();
  }, deadlineMs);
  await sample();

  await settleWithin(closed, deadlineMs + cleanupGraceMs);
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    timedOut = true;
    timeoutTriggeredAtMs ??= Date.now();
    await requestTermination();
    await settleWithin(closed, cleanupGraceMs);
  }

  clearInterval(sampler);
  clearTimeout(deadline);
  if (terminationPromise) await settleWithin(terminationPromise, cleanupGraceMs);
  await sample();
  child.stdout?.destroy();
  child.stderr?.destroy();

  const survivorDeadline = Date.now() + survivorSettleMs;
  let survivorPids = [];
  try {
    do {
      const liveProcesses = await processTableReader();
      const observedIdentities = [...observedProcesses].map(([pid, startedAtMs]) => ({
        pid,
        startedAtMs,
      }));
      survivorPids = survivingProcessIds(observedIdentities, liveProcesses);
      if (survivorPids.length === 0 || Date.now() >= survivorDeadline) break;
      await wait(Math.min(100, survivorDeadline - Date.now()));
    } while (Date.now() < survivorDeadline);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    processInspectionErrors.push(message);
    output.append(`\n[supervisor survivor check failed: ${message}]\n`);
  }

  const survivorCheckCompletedAtMs = Date.now();
  const elapsedFromStart = (timestamp) => (timestamp === null ? null : timestamp - startedAtMs);
  const tail = output.snapshot();
  return {
    pid: child.pid ?? null,
    startedAtMs,
    deadlineAtMs,
    elapsedMs: survivorCheckCompletedAtMs - startedAtMs,
    deadlineMs,
    cleanupGraceMs,
    survivorSettleMs,
    sampleMs,
    timedOut,
    timeoutTriggeredAtMs,
    timeoutTriggeredElapsedMs: elapsedFromStart(timeoutTriggeredAtMs),
    terminationRequestedAtMs,
    terminationRequestedElapsedMs: elapsedFromStart(terminationRequestedAtMs),
    terminationCompletedAtMs,
    terminationCompletedElapsedMs: elapsedFromStart(terminationCompletedAtMs),
    processClosedAtMs,
    processClosedElapsedMs: elapsedFromStart(processClosedAtMs),
    survivorCheckCompletedAtMs,
    terminationError,
    exitCode,
    signal,
    spawnError,
    peakTreeRssBytes,
    observedProcessCount: observedProcesses.size,
    processInspectionErrorCount: processInspectionErrors.length,
    processInspectionErrors,
    survivorCount: survivorPids.length,
    survivorPids,
    outputTail: tail.text,
    outputTailBytes: tail.bytes,
    outputTruncated: tail.truncated,
  };
}

export async function runEvidenceRuns(options = {}) {
  const runs = options.runs ?? DEFAULT_RUNS;
  const run = options.run ?? runSupervisedProcess;
  const command = options.command ?? (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  const args = options.args ?? [
    "--filter",
    "gg-app",
    "exec",
    "vitest",
    "run",
    "src/WorkspaceShell.test.tsx",
  ];
  const results = [];

  for (let index = 0; index < runs; index += 1) {
    const result = await run(command, args, {
      cwd: options.cwd ?? repoRoot,
      deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
      tailBytes: options.tailBytes ?? DEFAULT_TAIL_BYTES,
      sampleMs: options.sampleMs ?? DEFAULT_SAMPLE_MS,
      shell: process.platform === "win32",
    });
    const evidence = { run: index + 1, platform: process.platform, ...result };
    results.push(evidence);
    options.onResult?.(evidence);
  }

  const peaks = results.map((result) => result.peakTreeRssBytes);
  return {
    platform: process.platform,
    runs,
    deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    peakTreeRssBytes: peaks,
    peakGrowthBytes: peaks.length > 1 ? peaks.at(-1) - peaks[0] : 0,
    totalSurvivors: results.reduce((total, result) => total + result.survivorCount, 0),
    passed: results.every(
      (result) =>
        !result.timedOut &&
        result.exitCode === 0 &&
        !result.spawnError &&
        !result.terminationError &&
        result.peakTreeRssBytes > 0 &&
        !result.processInspectionErrorCount &&
        result.survivorCount === 0,
    ),
    results,
  };
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--runs") options.runs = positiveInteger(value, flag);
    else if (flag === "--deadline-ms") options.deadlineMs = positiveInteger(value, flag);
    else if (flag === "--tail-bytes") options.tailBytes = positiveInteger(value, flag);
    else if (flag === "--sample-ms") options.sampleMs = positiveInteger(value, flag);
    else throw new Error(`Unknown argument: ${flag}`);
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const summary = await runEvidenceRuns({
    ...options,
    onResult(result) {
      console.log(`PHASE00_RUN=${JSON.stringify(result)}`);
    },
  });
  console.log(`PHASE00_SUMMARY=${JSON.stringify({ ...summary, results: undefined })}`);
  process.exitCode = summary.passed ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
