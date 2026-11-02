import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { environmentSecrets, redactText } from "@kenkaiiii/gg-ai";
import { resolveShell } from "../core/shell.js";
import { killProcessTree } from "../utils/process.js";

/**
 * Commands the user runs themselves from the app's input (`!git status`).
 *
 * Not the agent's bash tool: no sandbox, no guards, no timeout. These run with
 * the user's own shell, environment and permissions in the project folder,
 * exactly as if typed in a terminal, and only ever because the user submitted
 * them (see shell-routes.ts for the confirmation gate).
 */

/**
 * Error output (stderr) is wrapped in these private-use characters in the
 * window's copy of the output, so it can be shown differently while keeping
 * its place among normal output. The agent's copy never contains them. The
 * app (ShellBlock.tsx) uses the same two characters.
 */
export const STDERR_START = "\uE000";
export const STDERR_END = "\uE001";
const STDERR_MARKS = /[\uE000\uE001]/g;

export function stripStderrMarks(text: string): string {
  return text.replace(STDERR_MARKS, "");
}

/** A cut that starts inside error output reopens it, so the first lines keep their look. */
export function reopenStderr(text: string): string {
  const end = text.indexOf(STDERR_END);
  const start = text.indexOf(STDERR_START);
  return end !== -1 && (start === -1 || end < start) ? STDERR_START + text : text;
}

/** Output streamed to the window per command; the rest is summarised. */
export const SHELL_DISPLAY_MAX_CHARS = 1_000_000;
/** What the agent (and the saved transcript) gets: the end, where results are. */
export const SHELL_CONTEXT_MAX_LINES = 200;
export const SHELL_CONTEXT_MAX_CHARS = 16_000;
export const SHELL_COMMAND_MAX_CHARS = 8_000;
/** Batch chunks into one window frame at most this often. */
const FLUSH_MS = 50;
/** After the shell exits, how long leftover children may hold its output pipes. */
const LEFTOVER_GRACE_MS = 1_000;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ShellRunEnd {
  runId: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** Stopped by the user. */
  cancelled: boolean;
  /** The last lines of output (redacted, plain text), for the agent. */
  tail: string;
  /** The same lines with error output marked, for the saved row. */
  displayTail: string;
  /** True when `tail` is not the whole output. */
  tailTruncated: boolean;
  /** True when the window stopped receiving output partway. */
  displayTruncated: boolean;
  /** The shell itself could not start. */
  error?: string;
}

export type ParsedShellRun =
  { ok: true; runId: string; command: string; confirmed: boolean } | { ok: false; error: string };

export function parseShellRunBody(raw: string): ParsedShellRun {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON body" };
  }
  if (typeof body !== "object" || body === null) return { ok: false, error: "invalid body" };
  const { id, command, confirmed } = body as Record<string, unknown>;
  if (typeof id !== "string" || !RUN_ID.test(id)) return { ok: false, error: "invalid run id" };
  if (typeof command !== "string" || !command.trim()) return { ok: false, error: "empty command" };
  if (command.length > SHELL_COMMAND_MAX_CHARS) return { ok: false, error: "command too long" };
  return { ok: true, runId: id, command: command.trim(), confirmed: confirmed === true };
}

/** The user's own environment, minus the app's private daemon variables. */
export function userShellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("GG_APP_")) continue;
    out[key] = value;
  }
  // Output goes to a panel, not a terminal: ask tools for plain text.
  out.TERM = "dumb";
  return out;
}

/**
 * The user's login shell ($SHELL) where there is one, so their usual shell
 * syntax works; otherwise the same shell the agent uses (Git Bash or cmd on
 * Windows).
 */
export function userShellLaunch(
  command: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): { file: string; args: string[] } {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const login = env.SHELL?.trim();
  if (platform !== "win32" && login && path.isAbsolute(login)) {
    return { file: login, args: ["-c", command] };
  }
  const shell = resolveShell(command, { platform, env });
  return { file: shell.file, args: shell.args };
}

/** The last `maxLines` lines, capped to `maxChars`, and whether anything was cut. */
export function tailOutput(
  text: string,
  maxLines = SHELL_CONTEXT_MAX_LINES,
  maxChars = SHELL_CONTEXT_MAX_CHARS,
): { text: string; truncated: boolean } {
  const trimmed = text.replace(/\s+$/, "");
  let start = trimmed.length;
  let lines = 0;
  while (start > 0 && lines < maxLines) {
    const nl = trimmed.lastIndexOf("\n", start - 1);
    start = nl === -1 ? 0 : nl;
    lines++;
    if (nl === -1) break;
  }
  let out = trimmed.slice(start === 0 ? 0 : start + 1);
  let truncated = start > 0;
  if (out.length > maxChars) {
    out = out.slice(out.length - maxChars);
    const nl = out.indexOf("\n");
    if (nl !== -1 && nl < out.length - 1) out = out.slice(nl + 1);
    truncated = true;
  }
  return { text: out, truncated };
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** One command, as the agent reads it. */
export function formatShellContext(run: ShellRunEnd): string {
  const facts = [
    `in ${run.cwd}`,
    run.error
      ? `failed to start: ${run.error}`
      : run.cancelled
        ? "stopped by the user before it finished"
        : `exit code ${run.exitCode ?? run.signal ?? "unknown"}`,
    seconds(run.durationMs),
  ];
  if (run.tailTruncated) facts.push(`showing the last ${SHELL_CONTEXT_MAX_LINES} lines or fewer`);
  const output = run.tail ? run.tail : "(no output)";
  return `$ ${run.command}\n(${facts.join(", ")})\n${output}`;
}

interface LiveRun {
  child: ChildProcess;
  cancelled: boolean;
}

export interface ShellRunnerOptions {
  /** Window frames: shell_output { id, chunk }. */
  emit: (type: string, data: unknown) => void;
  onEnd: (run: ShellRunEnd) => void;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
}

/** The user's commands for one window session. */
export class ShellRunner {
  private readonly runs = new Map<string, LiveRun>();

  constructor(private readonly opts: ShellRunnerOptions) {}

  isRunning(runId: string): boolean {
    return this.runs.has(runId);
  }

  start(runId: string, command: string, cwd: string): { ok: true } | { ok: false; error: string } {
    if (this.runs.has(runId)) return { ok: false, error: "run id already in use" };
    const env = this.opts.env ?? process.env;
    const now = this.opts.now ?? Date.now;
    const startedAt = now();
    const launch = userShellLaunch(command, { platform: this.opts.platform, env });
    const secrets = environmentSecrets(env);
    let child: ChildProcess;
    try {
      child = (this.opts.spawn ?? nodeSpawn)(launch.file, launch.args, {
        cwd,
        env: userShellEnv(env),
        // Own process group, so Stop ends everything the command started.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const live: LiveRun = { child, cancelled: false };
    this.runs.set(runId, live);

    let shown = 0;
    let displayTruncated = false;
    let pending = "";
    let tail = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      flushTimer = null;
      if (!pending) return;
      this.opts.emit("shell_output", { id: runId, chunk: pending });
      pending = "";
    };
    const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
    const onText = (raw: string, isError = false): void => {
      if (!raw) return;
      const clean = stripStderrMarks(raw);
      const text = isError && clean ? STDERR_START + clean + STDERR_END : clean;
      if (!text) return;
      tail = (tail + text).slice(-SHELL_CONTEXT_MAX_CHARS * 2);
      if (displayTruncated) return;
      const room = SHELL_DISPLAY_MAX_CHARS - shown;
      const part = text.length > room ? text.slice(0, room) : text;
      shown += part.length;
      pending += part;
      if (part.length < text.length) displayTruncated = true;
      flushTimer ??= setTimeout(flush, FLUSH_MS);
    };
    child.stdout?.on("data", (data: Buffer) => onText(decoders[0]!.write(data)));
    child.stderr?.on("data", (data: Buffer) => onText(decoders[1]!.write(data), true));

    let spawnError: string | undefined;
    let ended = false;
    let leftoverTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (ended) return;
      ended = true;
      if (leftoverTimer) clearTimeout(leftoverTimer);
      onText(decoders[0]!.end());
      onText(decoders[1]!.end(), true);
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      this.runs.delete(runId);
      const cut = tailOutput(reopenStderr(tail));
      const displayTail = redactText(reopenStderr(cut.text), { secrets });
      this.opts.onEnd({
        runId,
        command,
        cwd,
        exitCode,
        signal,
        durationMs: Math.max(0, now() - startedAt),
        cancelled: live.cancelled,
        tail: stripStderrMarks(displayTail).replace(/\s+$/, ""),
        displayTail,
        tailTruncated: cut.truncated || tail.length >= SHELL_CONTEXT_MAX_CHARS * 2,
        displayTruncated,
        ...(spawnError ? { error: spawnError } : {}),
      });
    };
    child.on("error", (err) => {
      spawnError = err.message;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    // `cmd &` leaves children holding the pipes, so "close" would wait on
    // them. Once the shell itself is gone, give output a moment to drain,
    // then stop the leftovers.
    child.on("exit", (code, signal) => {
      leftoverTimer = setTimeout(() => {
        if (child.pid) killProcessTree(child.pid);
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, LEFTOVER_GRACE_MS);
    });
    return { ok: true };
  }

  /** Stop one command and everything it started. False when it isn't running. */
  cancel(runId: string): boolean {
    const live = this.runs.get(runId);
    if (!live) return false;
    live.cancelled = true;
    if (live.child.pid) killProcessTree(live.child.pid);
    else live.child.kill("SIGKILL");
    return true;
  }

  /** Window closing: stop every command still running. */
  stopAll(): void {
    for (const runId of [...this.runs.keys()]) this.cancel(runId);
  }
}
