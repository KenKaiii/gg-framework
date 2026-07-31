import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import type {
  BashDiagnostics,
  BashToolResultDetails,
  ForegroundExecutionOutcome,
  ForegroundExecutionReason,
} from "../types.js";
import type { ProcessTarget } from "../utils/process.js";
import { log } from "../core/logger.js";
import { truncateTail, MAX_BYTES } from "./truncate.js";
import { compressToolOutput } from "./compress.js";
import { writeOverflow } from "./overflow.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { getSafeToolEnv } from "./safe-env.js";
import { resolveShell, type ResolveShellOpts } from "../core/shell.js";
import { PersistentShell } from "../core/persistent-shell.js";
import { isReadOnlyCommand } from "./read-only-bash.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import { isCatastrophicCommand } from "../core/workspace-guard.js";
import { checkCommandPolicy, type GetNetworkPolicy } from "../core/network-guard.js";
import {
  BOUNDED_OUTPUT_MAX_BYTES,
  BOUNDED_OUTPUT_MAX_LINES,
  BoundedOutputTail,
  type BoundedOutputTailSnapshot,
  OutputChunkDecoder,
} from "./bounded-output-tail.js";

const DEFAULT_TIMEOUT = 120_000; // 120 seconds
const FOREGROUND_TIMEOUT_CLEANUP_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = BOUNDED_OUTPUT_MAX_BYTES;

/**
 * Render command output for the tool result. Over-limit output is compressed
 * (keeps errors + head/tail, collapses repeats) rather than blindly
 * tail-sliced, and the raw output is offloaded to `~/.gg/tool-output/` so the
 * model can recover the lost portion with `read --offset` instead of
 * re-running the command. The offload is best-effort — a full disk or
 * permission error never fails the tool result.
 */
export async function renderBashOutput(rawOutput: string): Promise<string> {
  const result = truncateTail(rawOutput);
  if (!result.truncated) return result.content;
  const overflowPath =
    Buffer.byteLength(rawOutput, "utf-8") > MAX_BYTES
      ? await writeOverflow(rawOutput, "bash").catch(() => null)
      : null;
  const overflowNotice = overflowPath
    ? ` Full output saved to ${overflowPath} — read it with offset/limit if needed.`
    : "";
  const c = compressToolOutput(rawOutput);
  return `[${c.notice}${overflowNotice}]\n${c.content}`;
}

export interface ForegroundCommandExecution {
  outcome: ForegroundExecutionOutcome;
  rawOutput: string;
  outputCapped: boolean;
  outputSnapshot: BoundedOutputTailSnapshot;
  isCmdFallback: boolean;
}

function bashDiagnostics(
  outcome: ForegroundExecutionOutcome,
  output: BoundedOutputTailSnapshot,
): BashDiagnostics {
  const { metadata } = outcome;
  return {
    executionId: metadata.executionId,
    pid: metadata.pid,
    command: metadata.command,
    cwd: metadata.cwd,
    startedAt: metadata.startedAt,
    timeoutMs: metadata.timeoutMs,
    reason: outcome.reason,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    elapsedMs: outcome.elapsedMs,
    logPath: metadata.logPath,
    tail: output.content,
    outputCapped: output.capped,
    totalOutputBytes: output.totalInputBytes,
    retainedOutputBytes: output.retainedBytes,
    droppedOutputBytes: Math.max(0, output.totalInputBytes - output.retainedBytes),
  };
}

function formatForegroundDiagnostics(outcome: ForegroundExecutionOutcome, tail: string): string {
  const { metadata } = outcome;
  return (
    "Execution diagnostics:\n" +
    `ID: ${metadata.executionId}\n` +
    `PID: ${metadata.pid ?? "unavailable"}\n` +
    `Command: ${metadata.command}\n` +
    `CWD: ${metadata.cwd}\n` +
    `Started: ${new Date(metadata.startedAt).toISOString()}\n` +
    `Timeout: ${metadata.timeoutMs}ms\n` +
    `Reason: ${outcome.reason}\n` +
    `Exit code: ${outcome.exitCode ?? "none"}\n` +
    `Signal: ${outcome.signal ?? "none"}\n` +
    `Elapsed: ${outcome.elapsedMs}ms\n` +
    `Log: ${metadata.logPath}\n` +
    `Final output (last ${BOUNDED_OUTPUT_MAX_LINES} lines):\n` +
    "--- begin final output ---\n" +
    tail +
    (tail.endsWith("\n") || tail.length === 0 ? "" : "\n") +
    "--- end final output ---"
  );
}

interface ForegroundCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  ops: ToolOperations;
  processManager: ProcessManager;
  onUpdate?: (output: string, totalBytes: number) => void;
  cleanupProcessTree?: (target: ProcessTarget) => Promise<void>;
  reapProcessWrapper?: (target: ProcessTarget) => void;
}

type ForegroundOutputSource = "stdout" | "stderr";

interface ForegroundOutputStreamState {
  source: ForegroundOutputSource;
  decoder: OutputChunkDecoder;
  binary: boolean;
  binaryBytes: number;
  reportedBinaryBytes: number;
}

export async function executeForegroundCommand({
  command,
  cwd,
  timeoutMs,
  signal,
  ops,
  processManager,
  onUpdate,
  cleanupProcessTree = ops.process.cleanupProcessTree,
  reapProcessWrapper: reapWrapper = ops.process.reapProcessWrapper,
}: ForegroundCommandOptions): Promise<ForegroundCommandExecution> {
  const startedAt = Date.now();
  const foregroundLog = await processManager.allocateForegroundLog();
  const shell = resolveShell(command);
  const outputTail = new BoundedOutputTail();
  let totalBytes = 0;
  let pid: number | null = null;
  let terminalIntent: "interruption" | "completion" | "spawnError" | null = null;
  let pendingInterruption: "timedOut" | "aborted" | null = null;
  let settled = false;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let cleanupGraceTimer: NodeJS.Timeout | undefined;
  let abortListenerRegistered = false;
  let child: ReturnType<ToolOperations["process"]["spawn"]> | null = null;
  let logBackpressured = false;
  let onStdoutData: ((data: Buffer) => void) | undefined;
  let onStderrData: ((data: Buffer) => void) | undefined;
  let flushStdout: (() => void) | undefined;
  let flushStderr: (() => void) | undefined;
  const onOutputPipeError = (): void => {};
  let onChildClose: ((code: number | null, closeSignal: NodeJS.Signals | null) => void) | undefined;
  let onChildError: ((error: Error) => void) | undefined;

  return new Promise((resolve) => {
    const currentTarget = (): ProcessTarget | null => {
      if (pid === null || child === null) return null;
      const trackedChild = child;
      return {
        pid,
        isExited: () =>
          typeof trackedChild.exitCode === "number" ||
          (trackedChild.signalCode !== null && trackedChild.signalCode !== undefined),
      };
    };

    const startCleanup = (target: ProcessTarget): void => {
      void Promise.resolve()
        .then(() => cleanupProcessTree(target))
        .catch((error: unknown) => {
          log("WARN", "bash", "Foreground process-tree cleanup failed", {
            pid: String(target.pid),
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };

    const reapCompletedWrapper = (target: ProcessTarget): void => {
      try {
        reapWrapper(target);
      } catch (error) {
        log("WARN", "bash", "Foreground wrapper cleanup failed", {
          pid: String(target.pid),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const writeForegroundLog = (record: string): void => {
      if (foregroundLog.write(record) || logBackpressured || settled) return;
      logBackpressured = true;
      child?.stdout?.pause();
      child?.stderr?.pause();
      void foregroundLog.waitForDrain().then(() => {
        if (!logBackpressured) return;
        logBackpressured = false;
        if (settled) return;
        child?.stdout?.resume();
        child?.stderr?.resume();
      });
    };

    const finalize = (
      reason: ForegroundExecutionReason,
      exitCode: number | null,
      closeSignal: NodeJS.Signals | null,
      error: Error | null = null,
    ): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (cleanupGraceTimer) clearTimeout(cleanupGraceTimer);
      if (abortListenerRegistered) signal.removeEventListener("abort", onAbort);
      if (child && onChildClose) child.off("close", onChildClose);
      if (child && onChildError) child.off("error", onChildError);
      if (child?.stdout && onStdoutData) child.stdout.off("data", onStdoutData);
      child?.stdout?.off("error", onOutputPipeError);
      if (child?.stdout && flushStdout) {
        child.stdout.off("end", flushStdout);
        child.stdout.off("close", flushStdout);
      }
      if (child?.stderr && onStderrData) child.stderr.off("data", onStderrData);
      child?.stderr?.off("error", onOutputPipeError);
      if (child?.stderr && flushStderr) {
        child.stderr.off("end", flushStderr);
        child.stderr.off("close", flushStderr);
      }
      flushStdout?.();
      flushStderr?.();
      if (logBackpressured) {
        logBackpressured = false;
        child?.stdout?.resume();
        child?.stderr?.resume();
      }
      const outputSnapshot = outputTail.snapshot();
      const result: ForegroundCommandExecution = {
        outcome: {
          metadata: {
            executionId: foregroundLog.executionId,
            command,
            cwd,
            startedAt,
            timeoutMs,
            pid,
            logPath: foregroundLog.logPath,
          },
          reason,
          exitCode,
          signal: closeSignal,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          error,
        },
        rawOutput: outputSnapshot.content,
        outputCapped: outputSnapshot.capped,
        outputSnapshot,
        isCmdFallback: shell.isCmdFallback,
      };
      void foregroundLog.close().then(() => {
        if (foregroundLog.error) {
          log("WARN", "bash", "Foreground log stream failed", {
            executionId: foregroundLog.executionId,
            logPath: foregroundLog.logPath,
            error: foregroundLog.error.message,
          });
        }
        resolve(result);
      });
    };

    const interrupt = (reason: "timedOut" | "aborted"): void => {
      if (settled || terminalIntent !== null) return;
      terminalIntent = "interruption";
      pendingInterruption = reason;
      const target = currentTarget();
      if (target) startCleanup(target);
      cleanupGraceTimer = setTimeout(() => {
        finalize(reason, null, null);
      }, FOREGROUND_TIMEOUT_CLEANUP_GRACE_MS);
    };

    const onAbort = (): void => interrupt("aborted");

    if (signal.aborted) {
      terminalIntent = "interruption";
      pendingInterruption = "aborted";
      finalize("aborted", null, null);
      return;
    }

    try {
      child = ops.process.spawn(shell.file, shell.args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: getSafeToolEnv(),
      });
      pid = child.pid ?? null;

      const stdoutState: ForegroundOutputStreamState = {
        source: "stdout",
        decoder: new OutputChunkDecoder(),
        binary: false,
        binaryBytes: 0,
        reportedBinaryBytes: 0,
      };
      const stderrState: ForegroundOutputStreamState = {
        source: "stderr",
        decoder: new OutputChunkDecoder(),
        binary: false,
        binaryBytes: 0,
        reportedBinaryBytes: 0,
      };
      const emitText = (source: ForegroundOutputSource, output: string): void => {
        if (!output) return;
        outputTail.append(output);
        writeForegroundLog(`[${source}] ${output}`);
        onUpdate?.(output, totalBytes);
      };
      const emitBinarySummary = (state: ForegroundOutputStreamState): void => {
        if (state.binaryBytes === state.reportedBinaryBytes) return;
        const marker = `[${state.source} binary output omitted: ${state.binaryBytes} bytes]\n`;
        state.reportedBinaryBytes = state.binaryBytes;
        outputTail.append(marker);
        writeForegroundLog(`[${state.source}] ${marker}`);
        onUpdate?.(marker, totalBytes);
      };
      const onData =
        (state: ForegroundOutputStreamState) =>
        (data: Buffer): void => {
          totalBytes += data.length;
          if (state.binary) {
            state.binaryBytes += data.length;
            return;
          }
          const decoded = state.decoder.write(data);
          if (decoded.binary) {
            state.binary = true;
            state.binaryBytes += decoded.unsafeBytes;
            emitBinarySummary(state);
            return;
          }
          emitText(state.source, decoded.text);
        };
      const flushDecoder = (state: ForegroundOutputStreamState): (() => void) => {
        let flushed = false;
        return () => {
          if (flushed) return;
          flushed = true;
          if (state.binary) {
            emitBinarySummary(state);
            return;
          }
          const decoded = state.decoder.end();
          if (decoded.binary) {
            state.binary = true;
            state.binaryBytes += decoded.unsafeBytes;
            emitBinarySummary(state);
            return;
          }
          emitText(state.source, decoded.text);
        };
      };
      // Output pipes can fail independently. Swallow their errors so the child
      // process close/error event remains the sole execution outcome authority.
      onStdoutData = onData(stdoutState);
      onStderrData = onData(stderrState);
      flushStdout = flushDecoder(stdoutState);
      flushStderr = flushDecoder(stderrState);
      child.stdout?.on("data", onStdoutData);
      child.stdout?.on("error", onOutputPipeError);
      child.stdout?.once("end", flushStdout);
      child.stdout?.once("close", flushStdout);
      child.stderr?.on("data", onStderrData);
      child.stderr?.on("error", onOutputPipeError);
      child.stderr?.once("end", flushStderr);
      child.stderr?.once("close", flushStderr);

      onChildClose = (code, closeSignal) => {
        if (terminalIntent === "interruption") {
          finalize(pendingInterruption!, code, closeSignal);
          return;
        }
        if (terminalIntent !== null) return;
        terminalIntent = "completion";
        const target = currentTarget();
        if (target) reapCompletedWrapper(target);
        finalize(code === 0 ? "completed" : "nonZeroExit", code, closeSignal);
      };
      onChildError = (error) => {
        if (terminalIntent === "interruption") {
          finalize(pendingInterruption!, null, null, error);
          return;
        }
        if (terminalIntent !== null) return;
        terminalIntent = "spawnError";
        finalize("spawnError", null, null, error);
      };
      child.on("close", onChildClose);
      child.on("error", onChildError);

      deadlineTimer = setTimeout(() => interrupt("timedOut"), timeoutMs);

      signal.addEventListener("abort", onAbort, { once: true });
      abortListenerRegistered = true;
      if (signal.aborted) onAbort();
    } catch (error) {
      finalize("spawnError", null, null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

interface PersistentCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  processManager: ProcessManager;
  shell: PersistentShell;
  onUpdate?: (output: string, totalBytes: number) => void;
}

async function executePersistentCommand({
  command,
  cwd,
  timeoutMs,
  signal,
  processManager,
  shell,
  onUpdate,
}: PersistentCommandOptions): Promise<ForegroundCommandExecution> {
  const startedAt = Date.now();
  const foregroundLog = await processManager.allocateForegroundLog();
  const result = await shell.run(command, timeoutMs, signal, onUpdate, foregroundLog);
  await foregroundLog.close();
  if (foregroundLog.error) {
    log("WARN", "bash", "Persistent foreground log stream failed", {
      executionId: foregroundLog.executionId,
      logPath: foregroundLog.logPath,
      error: foregroundLog.error.message,
    });
  }

  return {
    outcome: {
      metadata: {
        executionId: foregroundLog.executionId,
        command,
        cwd,
        startedAt,
        timeoutMs,
        pid: result.pid,
        logPath: foregroundLog.logPath,
      },
      reason: result.reason,
      exitCode: result.exitCode,
      signal: result.signal,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      error: result.error,
    },
    rawOutput: result.output,
    outputCapped: result.outputSnapshot.capped,
    outputSnapshot: result.outputSnapshot,
    isCmdFallback: false,
  };
}

async function renderStructuredForegroundResult(
  execution: ForegroundCommandExecution,
  persistent: boolean,
): Promise<{ content: string; details: BashToolResultDetails }> {
  const { outcome } = execution;
  const diagnostics = formatForegroundDiagnostics(outcome, execution.rawOutput);
  const details: BashToolResultDetails = {
    bashDiagnostics: bashDiagnostics(outcome, execution.outputSnapshot),
  };
  if (outcome.reason === "spawnError") {
    return {
      content:
        `Exit code: 1\nFailed to spawn: ${outcome.error?.message ?? "Unknown error"}\n\n` +
        diagnostics,
      details,
    };
  }

  let output = await renderBashOutput(execution.rawOutput);
  if (execution.outputCapped) {
    output =
      `[Foreground output tail capped at ${BOUNDED_OUTPUT_MAX_LINES} lines / ` +
      `${MAX_OUTPUT_BYTES / 1024 / 1024} MB. Complete sanitized log: ` +
      `${outcome.metadata.logPath}]\n` +
      output;
  }
  // Windows without Git Bash: commands ran under cmd.exe, NOT bash. Tell
  // the model so it uses cmd syntax (no `ls`/`grep`/pipes/single-quotes)
  // and doesn't misread failures as a wrong directory / environment.
  if (execution.isCmdFallback) {
    output =
      "[Ran under Windows cmd.exe — bash is unavailable. Use cmd syntax " +
      "(dir, findstr, type); POSIX commands and quoting will fail. " +
      "Install Git for Windows to get bash.]\n" +
      output;
  }

  const exitCode =
    outcome.reason === "completed"
      ? "0"
      : outcome.reason === "timedOut"
        ? `TIMEOUT (${outcome.metadata.timeoutMs}ms)${
            persistent ? " — session shell was reset; cd/env state is gone" : ""
          }`
        : outcome.reason === "aborted"
          ? "ABORTED"
          : outcome.exitCode !== null
            ? String(outcome.exitCode)
            : outcome.signal
              ? `SIGNAL (${outcome.signal})`
              : "FAILED (no exit code)";

  return {
    content: `Exit code: ${exitCode}\n${output}\n\n${diagnostics}`,
    details,
  };
}

const BashParams = z.object({
  command: z.string().describe("The bash command to execute"),
  timeout: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe(
      "Foreground timeout in milliseconds (default: 120000). Finite build, test, lint, " +
        "format, migration, and one-shot commands wait for completion in foreground.",
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run long-lived or interactive commands in managed background mode. Use true for dev " +
        "servers, watchers, REPLs, scaffolders, and programs waiting for input; the call returns " +
        "after spawn with an ID, PID, and log. Default false for finite foreground commands.",
    ),
  persist: z
    .boolean()
    .optional()
    .describe(
      "Run in the persistent session shell: cd, exported env vars, and shell state " +
        "survive across persist:true calls. Use for multi-step workflows in another " +
        "directory or with sourced environments. Default false (fresh shell per call).",
    ),
});

export function createBashTool(
  cwd: string,
  processManager: ProcessManager,
  ops: ToolOperations = localOperations,
  planModeRef?: { current: boolean },
  shellOpts?: ResolveShellOpts,
  getNetworkPolicy?: GetNetworkPolicy,
): AgentTool<typeof BashParams> {
  // Lazily created on the first persist:true call; one session per tool
  // instance (i.e. per agent session), owned by the shared process manager.
  let sessionShell: PersistentShell | null = null;
  // Shell selection doesn't depend on the command, so resolve ONCE at tool
  // creation and bake the true execution environment into the description —
  // promising bash on a cmd.exe fallback makes the model write POSIX commands
  // that all fail. The runtime output banner below stays as belt-and-braces
  // for mid-session PATH changes.
  const isCmdFallback = resolveShell("", shellOpts ?? {}).isCmdFallback;
  const description = isCmdFallback
    ? "Execute a command under Windows cmd.exe (no bash was found on this system). " +
      "The working directory is already set to the project root — " +
      "don't cd into it redundantly. Use cd only when you need a different directory. " +
      "Returns exit code and combined stdout/stderr. " +
      "Use cmd.exe syntax (dir, findstr, type, del); POSIX commands and bash syntax " +
      "(ls, grep, cat, &&-chains relying on bash semantics, $(...), single-quoting) will fail. " +
      "Finite build, test, lint, format, migration, and one-shot commands run in foreground and wait " +
      "for final status under the default 120000ms timeout. Long output is truncated (tail kept). " +
      "Set run_in_background=true for long-lived or interactive commands " +
      "(dev servers, watchers, REPLs, scaffolders, programs that prompt for input); the call returns " +
      "after spawn. Use task_output to read output, task_send to type input/answer prompts, and " +
      "task_stop to stop background processes."
    : "Execute a bash command. The shell's working directory is already set to the project root — " +
      "don't cd into it redundantly. Use cd only when you need a different directory. " +
      "Returns exit code and combined stdout/stderr. " +
      "Commands run in a non-interactive bash shell with TERM=dumb. " +
      "Finite build, test, lint, format, migration, and one-shot commands run in foreground and wait " +
      "for final status under the default 120000ms timeout. Long output is truncated (tail kept). " +
      "Set run_in_background=true for long-lived or interactive commands " +
      "(dev servers, watchers, REPLs, scaffolders, programs that prompt for input); the call returns " +
      "after spawn. Use task_output to read output, task_send to type input/answer prompts, and " +
      "task_stop to stop background processes. " +
      "Set persist=true to run in a foreground session shell where cd/env state survives across " +
      "persist:true calls.";
  return {
    name: "bash",
    description,
    parameters: BashParams,
    executionMode: "sequential",
    async execute({ command, timeout: timeoutMs, run_in_background, persist }, context) {
      const commandMode = run_in_background === true ? "background" : "foreground";
      if (isPlanModeActive(planModeRef) && !isReadOnlyCommand(command)) {
        return planModeRestriction("bash");
      }
      // Catastrophic-command guard — enforced in code, before every execution
      // path (persistent shell, background, and normal spawn).
      const catastrophic = isCatastrophicCommand(command, cwd);
      if (catastrophic) {
        return `Error: ${catastrophic}`;
      }
      const networkBlocked = checkCommandPolicy(command, getNetworkPolicy);
      if (networkBlocked) {
        return `Error: ${networkBlocked}`;
      }
      // Persistent session mode — POSIX only; Windows-without-bash falls through
      // to the normal spawn path (cmd.exe fallback) below.
      if (
        persist &&
        commandMode === "foreground" &&
        !resolveShell(command, shellOpts).isCmdFallback
      ) {
        if (!sessionShell) {
          const shell = new PersistentShell(
            cwd,
            getSafeToolEnv(),
            MAX_OUTPUT_BYTES,
            ops.process,
            shellOpts,
          );
          sessionShell = shell;
          processManager.registerShutdown(() => shell.killNow());
        }
        const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT;
        const execution = await executePersistentCommand({
          command,
          cwd,
          timeoutMs: effectiveTimeout,
          signal: context.signal,
          processManager,
          shell: sessionShell,
          onUpdate: context.onUpdate
            ? (output, totalBytes) =>
                context.onUpdate?.({ type: "bash_progress", output, totalBytes })
            : undefined,
        });
        return renderStructuredForegroundResult(execution, true);
      }
      if (commandMode === "background") {
        const result = await processManager.start(command, cwd);
        return (
          `Background process started.\n` +
          `ID: ${result.id}\n` +
          `PID: ${result.pid}\n` +
          `Log: ${result.logFile}\n` +
          `Use task_output with id="${result.id}" to read output, ` +
          `task_send to type input/answer prompts, task_stop to stop it.`
        );
      }

      const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT;
      const execution = await executeForegroundCommand({
        command,
        cwd,
        timeoutMs: effectiveTimeout,
        signal: context.signal,
        ops,
        processManager,
        onUpdate: context.onUpdate
          ? (output, totalBytes) =>
              context.onUpdate?.({ type: "bash_progress", output, totalBytes })
          : undefined,
      });
      return renderStructuredForegroundResult(execution, false);
    },
  };
}
