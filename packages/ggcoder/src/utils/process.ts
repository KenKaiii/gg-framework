import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { log } from "../core/logger.js";

const TASKKILL_TREE_ARGUMENTS = (pid: number): string[] => ["/PID", String(pid), "/T", "/F"];
const TASKKILL_PROCESS_ARGUMENTS = (pid: number): string[] => ["/PID", String(pid), "/F"];
const DEFAULT_TASKKILL_TIMEOUT_MS = 5_000;
const POSIX_PS_PATH = "/bin/ps";
const POSIX_PS_ARGUMENTS = ["-A", "-o", "pid=,ppid="];
const DEFAULT_POSIX_PS_TIMEOUT_MS = 150;
const DEFAULT_POSIX_PS_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_POSIX_MAX_DESCENDANTS = 1_024;
export const DEFAULT_POSIX_TERM_GRACE_MS = 500;

export interface ProcessTarget {
  pid: number;
  isExited?: () => boolean;
}

export type ProcessTargetInput = number | ProcessTarget;

export interface ProcessTreeKillOptions {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  spawnSync?: typeof spawnSync;
  kill?: typeof process.kill;
  env?: NodeJS.ProcessEnv;
  taskkillTimeoutMs?: number;
  posixGraceMs?: number;
  posixPsTimeoutMs?: number;
  posixPsOutputBytes?: number;
  posixMaxDescendants?: number;
}

export type AsyncProcessTreeKillOptions = ProcessTreeKillOptions;

function getEnvCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(env).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

export function normalizeWindowsSystemRoot(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const root = value.trim();
  const hasUnsafeCharacter = [...root].some((character) => {
    const code = character.charCodeAt(0);
    return character === ";" || code <= 31 || code === 127;
  });
  if (!/^[A-Za-z]:[\\/]/.test(root) || hasUnsafeCharacter) return undefined;
  return path.win32.normalize(root);
}

export function resolveWindowsTaskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot =
    normalizeWindowsSystemRoot(getEnvCaseInsensitive(env, "SystemRoot")) ??
    normalizeWindowsSystemRoot(getEnvCaseInsensitive(env, "WINDIR")) ??
    "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function resolveProcessTarget(target: ProcessTargetInput): ProcessTarget {
  return typeof target === "number" ? { pid: target } : target;
}

function originalProcessExited(target: ProcessTarget): boolean {
  try {
    return target.isExited?.() ?? false;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number, kill: typeof process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    return true;
  }
}

function warnPosix(message: string, pid: number, details: Record<string, string> = {}): void {
  log("WARN", "process", message, { pid: String(pid), ...details });
}

function parseDescendants(output: string, rootPid: number, maximum: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!validPid(pid) || !validPid(parentPid) || pid === rootPid) continue;
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }

  const descendants: Array<{ pid: number; depth: number }> = [];
  const seen = new Set<number>([rootPid]);
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  while (queue.length > 0 && descendants.length < maximum) {
    const parent = queue.shift()!;
    for (const childPid of children.get(parent.pid) ?? []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      const child = { pid: childPid, depth: parent.depth + 1 };
      descendants.push(child);
      queue.push(child);
      if (descendants.length >= maximum) break;
    }
  }
  return descendants.sort((a, b) => b.depth - a.depth).map(({ pid }) => pid);
}

function snapshotDescendantsSync(pid: number, options: ProcessTreeKillOptions): number[] {
  try {
    const result = (options.spawnSync ?? spawnSync)(POSIX_PS_PATH, POSIX_PS_ARGUMENTS, {
      encoding: "utf8",
      timeout: options.posixPsTimeoutMs ?? DEFAULT_POSIX_PS_TIMEOUT_MS,
      maxBuffer: options.posixPsOutputBytes ?? DEFAULT_POSIX_PS_OUTPUT_BYTES,
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) {
      throw result.error ?? new Error(`ps exited with status ${String(result.status)}`);
    }
    return parseDescendants(
      typeof result.stdout === "string" ? result.stdout : "",
      pid,
      options.posixMaxDescendants ?? DEFAULT_POSIX_MAX_DESCENDANTS,
    );
  } catch (error) {
    warnPosix("POSIX descendant snapshot failed", pid, { error: errorDetail(error) });
    return [];
  }
}

async function snapshotDescendantsAsync(
  pid: number,
  options: AsyncProcessTreeKillOptions,
): Promise<number[]> {
  let helper: ChildProcess;
  try {
    helper = (options.spawn ?? spawn)(POSIX_PS_PATH, POSIX_PS_ARGUMENTS, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch (error) {
    warnPosix("POSIX descendant snapshot failed", pid, { error: errorDetail(error) });
    return [];
  }

  const outputLimit = options.posixPsOutputBytes ?? DEFAULT_POSIX_PS_OUTPUT_BYTES;
  const result = await new Promise<{ output?: string; error?: unknown }>((resolve) => {
    let settled = false;
    let output = "";
    let overflow = false;
    let timedOut = false;
    let reapTimer: NodeJS.Timeout | undefined;
    const stdout = helper.stdout;
    const settle = (value: { output?: string; error?: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (reapTimer) clearTimeout(reapTimer);
      helper.off("error", onError);
      helper.off("close", onClose);
      stdout?.off("data", onData);
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      if (overflow) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > outputLimit) {
        overflow = true;
        try {
          helper.kill("SIGKILL");
        } catch {
          // The bounded snapshot will settle through close or its timeout.
        }
      }
    };
    const onError = (error: Error): void => settle({ error });
    const onClose = (status: number | null): void => {
      if (timedOut) settle({ error: new Error("ps timed out") });
      else if (overflow) settle({ error: new Error("ps output exceeded limit") });
      else if (status === 0) settle({ output });
      else settle({ error: new Error(`ps exited with status ${String(status)}`) });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        helper.kill("SIGKILL");
      } catch {
        // Settlement still proceeds and direct-PID fallback remains available.
      }
      // Normally SIGKILL produces close immediately; retain a hard bound for a broken handle.
      reapTimer = setTimeout(() => settle({ error: new Error("ps timed out") }), 50);
    }, options.posixPsTimeoutMs ?? DEFAULT_POSIX_PS_TIMEOUT_MS);
    helper.once("error", onError);
    helper.once("close", onClose);
    stdout?.on("data", onData);
  });

  if (result.error !== undefined) {
    warnPosix("POSIX descendant snapshot failed", pid, { error: errorDetail(result.error) });
    return [];
  }
  return parseDescendants(
    result.output ?? "",
    pid,
    options.posixMaxDescendants ?? DEFAULT_POSIX_MAX_DESCENDANTS,
  );
}

function signalCapturedDescendants(
  rootPid: number,
  descendants: number[],
  signal: NodeJS.Signals,
  kill: typeof process.kill,
): void {
  for (const targetPid of descendants) {
    if (!isPidAlive(targetPid, kill)) continue;
    try {
      kill(targetPid, signal);
    } catch (error) {
      if (!isPidAlive(targetPid, kill)) continue;
      warnPosix("POSIX captured-descendant cleanup failed", rootPid, {
        targetPid: String(targetPid),
        signal,
        error: errorDetail(error),
      });
    }
  }
}

function fallbackSignal(
  target: ProcessTarget,
  descendants: number[],
  signal: NodeJS.Signals,
  kill: typeof process.kill,
): void {
  for (const targetPid of [...descendants, target.pid]) {
    if (originalProcessExited(target)) return;
    if (!isPidAlive(targetPid, kill)) continue;
    if (originalProcessExited(target)) return;
    try {
      kill(targetPid, signal);
    } catch (error) {
      if (!isPidAlive(targetPid, kill)) continue;
      warnPosix("POSIX process cleanup fallback failed", target.pid, {
        targetPid: String(targetPid),
        signal,
        error: errorDetail(error),
      });
    }
  }
}

function signalPosixGroup(
  target: ProcessTarget,
  descendants: number[],
  signal: NodeJS.Signals,
  kill: typeof process.kill,
): "sent" | "dead" | "failed" {
  if (originalProcessExited(target)) return "dead";
  try {
    kill(-target.pid, signal);
    return "sent";
  } catch (error) {
    if (originalProcessExited(target)) return "dead";
    const targetsAlive =
      descendants.some((targetPid) => isPidAlive(targetPid, kill)) || isPidAlive(target.pid, kill);
    if (!targetsAlive) return "dead";
    if (errorCode(error) !== "ESRCH") {
      warnPosix("POSIX process-group cleanup failed", target.pid, {
        signal,
        error: errorDetail(error),
      });
    }
    fallbackSignal(target, descendants, signal, kill);
    return "failed";
  }
}

function posixTargetsAlive(
  pid: number,
  descendants: number[],
  groupAvailable: boolean,
  kill: typeof process.kill,
): boolean {
  if (groupAvailable && isPidAlive(-pid, kill)) return true;
  return descendants.some((targetPid) => isPidAlive(targetPid, kill)) || isPidAlive(pid, kill);
}

function warnTaskkillFailure(
  pid: number,
  executable: string,
  failureKind: "access-denied" | "launch" | "non-zero" | "timed-out",
  details: { error?: unknown; status?: number | null; signal?: NodeJS.Signals | null },
): void {
  log("WARN", "process", "Windows process-tree cleanup failed", {
    pid: String(pid),
    executable,
    failureKind,
    ...(details.status === undefined ? {} : { status: String(details.status) }),
    ...(details.signal == null ? {} : { signal: details.signal }),
    ...(details.error === undefined ? {} : { error: errorDetail(details.error) }),
  });
}

function killSingleProcess(target: ProcessTarget, kill: typeof process.kill): void {
  if (originalProcessExited(target)) return;
  try {
    kill(target.pid, "SIGKILL");
  } catch (error) {
    if (originalProcessExited(target) || !isPidAlive(target.pid, kill)) return;
    log("WARN", "process", "Direct PID cleanup fallback failed", {
      pid: String(target.pid),
      error: errorDetail(error),
    });
  }
}

function handleWindowsTaskkillFailure(
  target: ProcessTarget,
  executable: string,
  kill: typeof process.kill,
  details: {
    error?: unknown;
    status?: number | null;
    signal?: NodeJS.Signals | null;
    timedOut?: boolean;
  },
): void {
  if (originalProcessExited(target) || !isPidAlive(target.pid, kill)) return;
  const code = errorCode(details.error);
  warnTaskkillFailure(
    target.pid,
    executable,
    details.timedOut
      ? "timed-out"
      : code === "EACCES" || code === "EPERM"
        ? "access-denied"
        : details.error !== undefined
          ? "launch"
          : "non-zero",
    details,
  );
  killSingleProcess(target, kill);
}

/** Kill a process and its descendants on the current platform. */
export function killProcessTree(
  targetInput: ProcessTargetInput,
  options: ProcessTreeKillOptions = {},
): void {
  const target = resolveProcessTarget(targetInput);
  const { pid } = target;
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? process.kill;

  if (platform !== "win32") {
    if (!validPid(pid)) {
      warnPosix("Refusing to clean up an invalid POSIX PID", pid);
      return;
    }
    if (originalProcessExited(target)) return;
    const descendants = snapshotDescendantsSync(pid, options);
    if (originalProcessExited(target)) return;
    const groupResult = signalPosixGroup(target, descendants, "SIGKILL", kill);
    if (groupResult !== "failed" || originalProcessExited(target)) {
      signalCapturedDescendants(pid, descendants, "SIGKILL", kill);
    }
    return;
  }

  if (originalProcessExited(target) || !isPidAlive(pid, kill)) return;
  const executable = resolveWindowsTaskkillPath(options.env);
  if (originalProcessExited(target)) return;
  try {
    const result = (options.spawnSync ?? spawnSync)(executable, TASKKILL_TREE_ARGUMENTS(pid), {
      stdio: "ignore",
      windowsHide: true,
      timeout: options.taskkillTimeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS,
    });
    if (result.status === 0 && result.error === undefined) return;
    handleWindowsTaskkillFailure(target, executable, kill, {
      error: result.error,
      status: result.status,
      signal: result.signal,
    });
  } catch (error) {
    handleWindowsTaskkillFailure(target, executable, kill, { error });
  }
}

/** Gracefully terminate a process tree, escalating without replacing the caller's outcome. */
export async function killProcessTreeAsync(
  targetInput: ProcessTargetInput,
  options: AsyncProcessTreeKillOptions = {},
): Promise<void> {
  const target = resolveProcessTarget(targetInput);
  const { pid } = target;
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? process.kill;

  if (platform !== "win32") {
    if (!validPid(pid)) {
      warnPosix("Refusing to clean up an invalid POSIX PID", pid);
      return;
    }
    if (originalProcessExited(target)) return;
    const descendants = await snapshotDescendantsAsync(pid, options);
    if (originalProcessExited(target)) return;
    const termResult = signalPosixGroup(target, descendants, "SIGTERM", kill);
    if (termResult === "dead") {
      signalCapturedDescendants(pid, descendants, "SIGKILL", kill);
      return;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, options.posixGraceMs ?? DEFAULT_POSIX_TERM_GRACE_MS),
    );
    if (originalProcessExited(target)) {
      signalCapturedDescendants(pid, descendants, "SIGKILL", kill);
      return;
    }
    if (!posixTargetsAlive(pid, descendants, termResult === "sent", kill)) return;
    const killResult = signalPosixGroup(target, descendants, "SIGKILL", kill);
    if (killResult !== "failed" || originalProcessExited(target)) {
      signalCapturedDescendants(pid, descendants, "SIGKILL", kill);
    }
    return;
  }

  if (originalProcessExited(target) || !isPidAlive(pid, kill)) return;
  const executable = resolveWindowsTaskkillPath(options.env);
  if (originalProcessExited(target)) return;
  let killer: ReturnType<typeof spawn>;
  try {
    killer = (options.spawn ?? spawn)(executable, TASKKILL_TREE_ARGUMENTS(pid), {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    handleWindowsTaskkillFailure(target, executable, kill, { error });
    return;
  }

  killer.unref();
  const failure = await new Promise<
    | { error: unknown; status?: undefined; signal?: undefined; timedOut?: undefined }
    | {
        error?: undefined;
        status: number | null;
        signal: NodeJS.Signals | null;
        timedOut?: undefined;
      }
    | { error?: undefined; status?: undefined; signal?: undefined; timedOut: true }
    | undefined
  >((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settle({ timedOut: true });
      try {
        killer.kill("SIGKILL");
      } catch {
        // The direct target-PID fallback below still runs after a taskkill timeout.
      }
      killer.unref();
    }, options.taskkillTimeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS);
    const settle = (result: Parameters<typeof resolve>[0]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killer.off("error", onError);
      killer.off("close", onClose);
      resolve(result);
    };
    const onError = (error: Error): void => settle({ error });
    const onClose = (status: number | null, signal: NodeJS.Signals | null): void =>
      settle(status === 0 ? undefined : { status, signal });
    killer.once("error", onError);
    killer.once("close", onClose);
  });

  if (failure !== undefined && !originalProcessExited(target)) {
    handleWindowsTaskkillFailure(target, executable, kill, failure);
  }
}

/** Reap only the tracked wrapper PID, never its descendants or process group. */
export function reapProcessWrapper(
  targetInput: ProcessTargetInput,
  options: ProcessTreeKillOptions = {},
): void {
  const target = resolveProcessTarget(targetInput);
  const { pid } = target;
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? process.kill;

  if (!validPid(pid) || originalProcessExited(target) || !isPidAlive(pid, kill)) return;
  if (originalProcessExited(target)) return;

  if (platform !== "win32") {
    killSingleProcess(target, kill);
    return;
  }

  const executable = resolveWindowsTaskkillPath(options.env);
  try {
    const result = (options.spawnSync ?? spawnSync)(executable, TASKKILL_PROCESS_ARGUMENTS(pid), {
      stdio: "ignore",
      windowsHide: true,
      timeout: options.taskkillTimeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS,
    });
    if (result.status === 0 && result.error === undefined) return;
    handleWindowsTaskkillFailure(target, executable, kill, {
      error: result.error,
      status: result.status,
      signal: result.signal,
    });
  } catch (error) {
    handleWindowsTaskkillFailure(target, executable, kill, { error });
  }
}
