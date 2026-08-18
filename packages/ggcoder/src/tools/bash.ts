import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import { killProcessTree } from "../utils/process.js";
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
  prepareSandboxLaunch,
  SANDBOX_ENV_PATCH,
  type SandboxPolicy,
  type SandboxLaunch,
} from "../core/sandbox.js";
import type { WakeRules } from "../core/process-manager.js";
import { annotateSandboxDenial } from "../core/sandbox-feedback.js";

/** Tool env, plus the tweaks that only make sense inside the OS sandbox. */
function sandboxAwareEnv(sandboxed: boolean): Record<string, string> {
  const env = getSafeToolEnv();
  return sandboxed ? { ...env, ...SANDBOX_ENV_PATCH } : env;
}

const DEFAULT_TIMEOUT = 120_000; // 120 seconds
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB — cap buffered output to prevent OOM

/**
 * Optional command-rewrite hook for the plain foreground spawn path (not
 * `persist` or `run_in_background` — see the call site for why). Given the
 * exact string the model asked to run, return a replacement to execute
 * instead, or `undefined`/`null` to run the command unchanged. Errors are
 * swallowed by the caller: a throwing rewriter behaves exactly like one that
 * returned nothing.
 *
 * All safety guards (plan mode, catastrophic-command, network policy) run
 * against the ORIGINAL command before this hook is ever called, so a
 * rewriter cannot be used to bypass them.
 *
 * Intended for callers who want to route commands through an external
 * compaction tool (e.g. github.com/rtk-ai/rtk, which rewrites common CLI
 * invocations like `git status` / `ps aux` into token-cheaper equivalents).
 * Nothing in this package ships such an integration — wiring one in is the
 * caller's choice, at the `createTools`/`createBashTool` call site.
 */
export type CommandRewriter = (command: string) => string | undefined | null;

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
  wake: z
    .object({
      pattern: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "A regex; the moment NEW output matches it you are actively woken with the " +
            "matching line — no task_output polling. Use for signals in long builds, " +
            "dev servers and watchers (e.g. 'compiled with errors', 'listening on').",
        ),
      silence_seconds: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .optional()
        .describe(
          "Wake me if the task produces no output at all for this many seconds while " +
            "still running — a stall/hang detector for commands that should be chatty.",
        ),
    })
    .refine((rules) => rules.pattern !== undefined || rules.silence_seconds !== undefined, {
      message: "Provide wake.pattern, wake.silence_seconds, or both.",
    })
    .optional()
    .describe(
      "Wake conditions for a background task (run_in_background only). You are " +
        "notified automatically the instant one holds, instead of polling " +
        "task_output. Each condition fires once; exit always notifies regardless.",
    ),
});

export function createBashTool(
  cwd: string,
  processManager: ProcessManager,
  ops: ToolOperations = localOperations,
  planModeRef?: { current: boolean },
  shellOpts?: ResolveShellOpts,
  getNetworkPolicy?: GetNetworkPolicy,
  getSandboxPolicy?: () => SandboxPolicy,
  rewriteCommand?: CommandRewriter,
): AgentTool<typeof BashParams> {
  // Lazily created on the first persist:true call; one session per tool
  // instance (i.e. per agent session), killed when the process exits.
  let sessionShell: PersistentShell | null = null;
  let sessionSandboxKey: string | null = null;
  let sessionSandboxed = false;
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
      "Long output is truncated (tail kept). " +
      "Set run_in_background=true for long-running OR interactive processes " +
      "(dev servers, watchers, REPLs, scaffolders, programs that prompt for input). " +
      "Use task_output to read output, task_send to type input/answer prompts, and " +
      "task_stop to stop background processes. " +
      "Commit, push, amend, or rewrite git history only when the user explicitly asked. " +
      "Kill processes by exact PID (taskkill /PID), never by image name alone."
    : "Execute a bash command. The shell's working directory is already set to the project root — " +
      "don't cd into it redundantly. Use cd only when you need a different directory. " +
      "Returns exit code and combined stdout/stderr. " +
      "Commands run in a non-interactive bash shell with TERM=dumb. " +
      "Long output is truncated (tail kept). " +
      "Set run_in_background=true for long-running OR interactive processes " +
      "(dev servers, watchers, REPLs, scaffolders, programs that prompt for input). " +
      "Use task_output to read output, task_send to type input/answer prompts, and " +
      "task_stop to stop background processes. " +
      "Commit, push, amend, or rewrite git history only when the user explicitly asked. " +
      "Never background a command with a trailing & or nohup — use run_in_background instead. " +
      "Kill processes by exact PID, never broad patterns like pkill -f node. " +
      "Set persist=true to run in a session shell where cd/env state survives across " +
      "persist:true calls. " +
      "With run_in_background, also set wake (pattern and/or silence_seconds) to be " +
      "actively notified the moment matching output appears or the task stalls.";
  return {
    name: "bash",
    description,
    parameters: BashParams,
    executionMode: "sequential",
    async execute({ command, timeout: timeoutMs, run_in_background, persist, wake }, context) {
      if (wake && !run_in_background) {
        return "Error: wake conditions require run_in_background=true — there is nothing to watch on a foreground call.";
      }
      let wakeRules: WakeRules | undefined;
      if (wake?.pattern) {
        try {
          // No flags: lastIndex-free exec/test keeps the watcher's scans pure.
          wakeRules = { pattern: new RegExp(wake.pattern) };
        } catch (error) {
          return `Error: wake.pattern is not a valid regex (${(error as Error).message}). Fix the pattern and retry.`;
        }
      }
      if (wake?.silence_seconds) {
        wakeRules = { ...wakeRules, silenceMs: wake.silence_seconds * 1000 };
      }
      if (isPlanModeActive(planModeRef) && !isReadOnlyCommand(command)) {
        return planModeRestriction("bash");
      }
      // Catastrophic-command guard — enforced in code, before every execution
      // path (persistent shell, background, and normal spawn).
      const catastrophic = isCatastrophicCommand(command, cwd);
      if (catastrophic) {
        return `Error: ${catastrophic}`;
      }
      // Network allowlist — defence in depth only. Recognises the common egress
      // command shapes; an unrecognised command is never blocked (see
      // core/network-guard.ts for why this is not a sandbox).
      const networkBlocked = checkCommandPolicy(command, getNetworkPolicy);
      if (networkBlocked) {
        return `Error: ${networkBlocked}`;
      }
      const sandboxPolicy = getSandboxPolicy?.() ?? { mode: "off", allowedDomains: [] };
      const prepareLaunch = async (
        shell: ReturnType<typeof resolveShell>,
      ): Promise<SandboxLaunch> => prepareSandboxLaunch(shell, cwd, sandboxPolicy);

      // Persistent session mode — POSIX only; Windows-without-bash falls through
      // to the normal spawn path (cmd.exe fallback) below.
      if (persist && !run_in_background && !resolveShell(command, shellOpts).isCmdFallback) {
        const sandboxKey = JSON.stringify(sandboxPolicy);
        if (sessionShell && sessionSandboxKey !== sandboxKey) {
          sessionShell.kill();
          sessionShell = null;
        }
        if (!sessionShell) {
          try {
            const shell = resolveShell("", shellOpts);
            const launch = await prepareLaunch({
              ...shell,
              args: ["--norc", "--noprofile"],
            });
            sessionShell = new PersistentShell(
              cwd,
              sandboxAwareEnv(launch.sandboxed),
              MAX_OUTPUT_BYTES,
              shellOpts,
              launch,
            );
            sessionSandboxKey = sandboxKey;
            sessionSandboxed = launch.sandboxed;
          } catch (error) {
            return `Error: OS sandbox unavailable; command was not run: ${(error as Error).message}`;
          }
        }
        const res = await sessionShell.run(
          command,
          timeoutMs ?? DEFAULT_TIMEOUT,
          context.signal,
          context.onUpdate
            ? (text) => context.onUpdate?.({ type: "bash_progress", output: text, totalBytes: 0 })
            : undefined,
        );
        const output = await renderBashOutput(res.output);
        const exitCode =
          res.exitCode === "TIMEOUT"
            ? `TIMEOUT (${timeoutMs ?? DEFAULT_TIMEOUT}ms) — session shell was reset; cd/env state is gone`
            : String(res.exitCode);
        return annotateSandboxDenial(`Exit code: ${exitCode}\n${output}`, sessionSandboxed);
      }
      if (run_in_background) {
        let launch: SandboxLaunch;
        try {
          launch = await prepareLaunch(resolveShell(command, shellOpts));
        } catch (error) {
          return `Error: OS sandbox unavailable; command was not run: ${(error as Error).message}`;
        }
        const result = await processManager.start(command, cwd, launch, wakeRules);
        return (
          `Background process started.\n` +
          `ID: ${result.id}\n` +
          `PID: ${result.pid}\n` +
          `Log: ${result.logFile}\n` +
          (wakeRules
            ? result.wakeArmed
              ? `Wake rules armed: ${[
                  wakeRules.pattern ? `pattern /${wakeRules.pattern.source}/` : null,
                  wakeRules.silenceMs ? `silence ${wakeRules.silenceMs / 1000}s` : null,
                ]
                  .filter(Boolean)
                  .join(
                    " + ",
                  )}. You will be notified automatically when one fires or the process exits.\n`
              : `Wake conditions were NOT armed: this session has no notification path, so nothing will wake you automatically. Poll task_output periodically instead.\n`
            : "") +
          `Use task_output with id="${result.id}" to read output, ` +
          `task_send to type input/answer prompts, task_stop to stop it.`
        );
      }

      const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT;

      // Optional rewrite, scoped to ONLY this plain foreground spawn path.
      // persist=true (stateful shell, tracks cd) and run_in_background=true
      // (long-running, output read later via task_output) are deliberately
      // left untouched -- rewriting there risks shell-state or output-timing
      // bugs for comparatively little benefit, since those paths are already
      // rarer and the output there is either already truncated/streamed or
      // tied to `cd`-sensitive session state a rewriter cannot see.
      let effectiveCommand = command;
      if (rewriteCommand) {
        try {
          effectiveCommand = rewriteCommand(command) ?? command;
        } catch {
          // A throwing rewriter must never break or block the original command.
          effectiveCommand = command;
        }
      }

      // Cross-platform shell: bash on macOS/Linux, Git Bash on Windows (or
      // cmd.exe fallback), wrapped by the OS sandbox before any child starts.
      const shell = resolveShell(effectiveCommand, shellOpts);
      let launch: SandboxLaunch;
      try {
        launch = await prepareLaunch(shell);
      } catch (error) {
        return `Exit code: 1\nOS sandbox unavailable; command was not run: ${(error as Error).message}`;
      }

      return new Promise<string>((resolve) => {
        const child = ops.spawn(launch.file, launch.args, {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: sandboxAwareEnv(launch.sandboxed),
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
          let output = await renderBashOutput(rawOutput);
          if (outputCapped) {
            output =
              `[Output capped at ${MAX_OUTPUT_BYTES / 1024 / 1024} MB to prevent memory exhaustion]\n` +
              output;
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

          resolve(annotateSandboxDenial(`Exit code: ${exitCode}\n${output}`, launch.sandboxed));
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
