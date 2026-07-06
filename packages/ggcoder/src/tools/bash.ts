import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import { killProcessTree } from "../utils/process.js";
import { truncateTail } from "./truncate.js";
import { compressToolOutput } from "./compress.js";
import { writeOverflow } from "./overflow.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { getSafeToolEnv } from "./safe-env.js";
import { resolveShell } from "../core/shell.js";
import { PersistentShell } from "../core/persistent-shell.js";
import { isReadOnlyCommand } from "./read-only-bash.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";

const DEFAULT_TIMEOUT = 120_000; // 120 seconds
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB — cap buffered output to prevent OOM

const BashParams = z.object({
  command: z.string().describe("The bash command to execute"),
  timeout: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe("Timeout in milliseconds (default: 120000)"),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run the command in the background. Returns a process ID immediately. " +
        "Use task_output to read output and task_stop to stop it.",
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
): AgentTool<typeof BashParams> {
  // Lazily created on the first persist:true call; one session per tool
  // instance (i.e. per agent session), killed when the process exits.
  let sessionShell: PersistentShell | null = null;
  return {
    name: "bash",
    description:
      "Execute a bash command. The shell's working directory is already set to the project root — " +
      "don't cd into it redundantly. Use cd only when you need a different directory. " +
      "Returns exit code and combined stdout/stderr. " +
      "Commands run in a non-interactive bash shell with TERM=dumb. " +
      "Long output is truncated (tail kept). " +
      "Set run_in_background=true for long-running OR interactive processes " +
      "(dev servers, watchers, REPLs, scaffolders, programs that prompt for input). " +
      "Use task_output to read output, task_send to type input/answer prompts, and " +
      "task_stop to stop background processes. " +
      "Set persist=true to run in a session shell where cd/env state survives across " +
      "persist:true calls.",
    parameters: BashParams,
    executionMode: "sequential",
    async execute({ command, timeout: timeoutMs, run_in_background, persist }, context) {
      if (isPlanModeActive(planModeRef) && !isReadOnlyCommand(command)) {
        return planModeRestriction("bash");
      }
      // Persistent session mode — POSIX only; Windows-without-bash falls through
      // to the normal spawn path (cmd.exe fallback) below.
      if (persist && !run_in_background && !resolveShell(command).isCmdFallback) {
        sessionShell ??= new PersistentShell(cwd, getSafeToolEnv(), MAX_OUTPUT_BYTES);
        const res = await sessionShell.run(
          command,
          timeoutMs ?? DEFAULT_TIMEOUT,
          context.signal,
          context.onUpdate
            ? (text) => context.onUpdate?.({ type: "bash_progress", output: text, totalBytes: 0 })
            : undefined,
        );
        const truncated = truncateTail(res.output);
        const exitCode =
          res.exitCode === "TIMEOUT"
            ? `TIMEOUT (${timeoutMs ?? DEFAULT_TIMEOUT}ms) — session shell was reset; cd/env state is gone`
            : String(res.exitCode);
        return `Exit code: ${exitCode}\n${truncated.content}`;
      }
      if (run_in_background) {
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

      return new Promise<string>((resolve) => {
        // Cross-platform shell: bash on macOS/Linux, Git Bash on Windows (or
        // cmd.exe fallback). Hardcoding "bash" broke on Windows with `spawn
        // bash ENOENT`, and accidentally hitting WSL's bash ran commands in a
        // separate Linux filesystem (the "files not mounted" symptom).
        const shell = resolveShell(command);
        const child = ops.spawn(shell.file, shell.args, {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: getSafeToolEnv(),
        });

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let outputCapped = false;

        const onData = (data: Buffer) => {
          if (outputCapped) return;
          totalBytes += data.length;
          if (totalBytes > MAX_OUTPUT_BYTES) {
            outputCapped = true;
            return;
          }
          chunks.push(data);

          // Stream progress to UI for live output display
          if (context.onUpdate) {
            context.onUpdate({
              type: "bash_progress",
              output: data.toString("utf-8"),
              totalBytes,
            });
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        let killed = false;
        let timedOut = false;

        // Timeout handling
        const timer = setTimeout(() => {
          timedOut = true;
          killed = true;
          if (child.pid) killProcessTree(child.pid);
        }, effectiveTimeout);

        // Abort signal handling
        const onAbort = () => {
          killed = true;
          if (child.pid) killProcessTree(child.pid);
        };
        context.signal.addEventListener("abort", onAbort, { once: true });

        child.on("close", async (code) => {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);

          const rawOutput = Buffer.concat(chunks).toString("utf-8");
          const result = truncateTail(rawOutput);

          let output = result.content;
          const capNotice = outputCapped
            ? `[Output capped at ${MAX_OUTPUT_BYTES / 1024 / 1024} MB to prevent memory exhaustion]\n`
            : "";
          if (outputCapped) {
            output = `${capNotice}${output}`;
          }
          if (result.truncated) {
            // Over-limit: a blind tail slice would drop the head and any
            // mid-stream error. Compress instead (keeps errors + head/tail,
            // collapses repeats); the overflow file preserves the original.
            const overflowPath = await writeOverflow(rawOutput, "bash").catch(() => null);
            const overflowNotice = overflowPath ? ` Full output: ${overflowPath}` : "";
            const c = compressToolOutput(rawOutput);
            output = `${capNotice}[${c.notice}${overflowNotice}]\n${c.content}`;
          }
          // Windows without Git Bash: commands ran under cmd.exe, NOT bash. Tell
          // the model so it uses cmd syntax (no `ls`/`grep`/pipes/single-quotes)
          // and doesn't misread failures as a wrong directory / environment.
          if (shell.isCmdFallback) {
            output =
              "[Ran under Windows cmd.exe — bash is unavailable. Use cmd syntax " +
              "(dir, findstr, type); POSIX commands and quoting will fail. " +
              "Install Git for Windows to get bash.]\n" +
              output;
          }

          const exitCode = timedOut
            ? `TIMEOUT (${effectiveTimeout}ms)`
            : killed
              ? "KILLED"
              : String(code ?? 1);

          resolve(`Exit code: ${exitCode}\n${output}`);
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);
          resolve(`Exit code: 1\nFailed to spawn: ${err.message}`);
        });
      });
    },
  };
}
