import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import { killProcessTree } from "../utils/process.js";
import { truncateTail, MAX_BYTES, describeCompressed } from "./truncate.js";
import { compressToolOutput } from "./compress.js";
import { writeOverflow } from "./overflow.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { getSafeToolEnv } from "./safe-env.js";
import { resolveShell, type ResolveShellOpts } from "../core/shell.js";
import { PersistentShell } from "../core/persistent-shell.js";
import { isReadOnlyCommand, sleepOnlySeconds } from "./read-only-bash.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import { isCatastrophicCommand } from "../core/workspace-guard.js";
import { checkDestructiveGit } from "../core/destructive-git-guard.js";
import { shellThreatBlockMessage } from "../core/shell-threats.js";
import { checkPackageInstall } from "../core/package-threats.js";
import {
  classifyVerificationCommand,
  containsBoundedCheck,
} from "../core/verification-evidence.js";
import { checkCommandPolicy, type GetNetworkPolicy } from "../core/network-guard.js";
import {
  prepareSandboxLaunch,
  SANDBOX_ENV_PATCH,
  type SandboxPolicy,
  type SandboxLaunch,
} from "../core/sandbox.js";
import type { WakeRules } from "../core/process-manager.js";
import { annotateSandboxDenial } from "../core/sandbox-feedback.js";
import { collectVerificationReview } from "./verification-review.js";

/** Tool env, plus the tweaks that only make sense inside the OS sandbox. */
function sandboxAwareEnv(sandboxed: boolean): Record<string, string> {
  const env = getSafeToolEnv();
  return sandboxed ? { ...env, ...SANDBOX_ENV_PATCH } : env;
}

const DEFAULT_TIMEOUT = 120_000; // 120 seconds

/** Host-authored rejection: no process started, so this is not a failed check. */
export const REVIEW_REJECTED_BEFORE_START =
  "Error: review requires a local, non-persistent foreground verification check. Pass only the check in command; do not combine it with edits or diff inspection. Nothing was run.";

const AUTO_BACKGROUND_RE =
  /^Still running after \d+(?:\.\d+)?s, so it was moved to the background\b/;

/**
 * Background process id when a bash result reports that a foreground command
 * outlived its default budget and was handed to the process manager. Such a
 * command has no exit code yet: its outcome arrives later, like an explicit
 * `run_in_background` run, so callers must not read the result as a failure.
 */
export function autoBackgroundedId(result: string): string | undefined {
  if (!AUTO_BACKGROUND_RE.test(result)) return undefined;
  return /^ID:\s*(\S+)$/m.exec(result)?.[1];
}
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB — cap buffered output to prevent OOM
/**
 * How long to keep collecting output after the shell exits while something it
 * left behind (`cmd &`, `nohup cmd`) still holds its stdout/stderr open.
 */
const LEFTOVER_DRAIN_MS = 1_000;

/**
 * Result for a call whose Stop arrived while the launch was still being
 * prepared. Wording matches the agent loop's result for a tool call that never
 * reached its tool.
 */
const CANCELLED_BEFORE_START =
  "Exit code: CANCELLED\n`bash` was cancelled before it started, so it had no effect. Safe to retry.";

/**
 * SIGKILL what is left of the process group the shell led, returning whether
 * anything was there to stop. Group-only: once the shell has exited its lone
 * pid may already belong to an unrelated process. Windows has no process
 * groups, and taskkill /T cannot find the tree of a parent that already
 * exited, so leftovers there are left running.
 */
function killLeftoverGroup(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    // The group is empty: whatever still holds the output left it (setsid).
    return false;
  }
}
/** A sleep at least this long is a guess at when something finishes, not a
 *  settle pause before poking a service that is already up. */
const GUESSED_WAIT_SECONDS = 10;

/**
 * Render command output for the tool result. Over-limit output is compressed
 * (keeps errors + head/tail, collapses repeats) rather than blindly
 * tail-sliced, and the raw output is offloaded to `~/.gg/tool-output/` so the
 * model can recover the lost portion with `read --offset` instead of
 * re-running the command. The offload is best-effort — a full disk or
 * permission error never fails the tool result.
 */
export async function renderBashOutput(
  rawOutput: string,
  command?: string,
  /** bash with pipefail (not the cmd.exe fallback): see classifyVerificationCommand. */
  posixShell = false,
): Promise<string> {
  // Feedback only when the command wraps a real check. Exploration that merely
  // mentions a verifier (`ls .venv/bin | grep ruff`) is not a verification
  // attempt; nagging it made the model reshape harmless commands repeatedly.
  // Showing the note only once per session was measured and rejected: it cut
  // notes by a third but raised tool calls 27% (bench/h2h/DIRAC-FINDINGS.md).
  const check =
    command && containsBoundedCheck(command)
      ? classifyVerificationCommand(command, { posixShell })
      : undefined;
  const feedback =
    check?.candidate && !check.accepted && check.snapshotPreserveOnly
      ? "\n\n[This mixed check/inspection chain cannot establish fresh verification; it can only preserve earlier successful checks. If the current changes are not already verified, run the check standalone or chain only checks with &&. Do not claim fresh verification from this shell exit status.]"
      : check?.candidate && !check.accepted && !check.snapshotEligible
        ? `\n\n[Verification evidence rejected: ${check.reason}. The output is still valid information; do not reshape this command to satisfy this note. When you need verification, run the check once as a standalone command (or chain only checks with &&) after your last edit, and do not claim verification from this shell exit status.]`
        : "";
  const result = truncateTail(rawOutput);
  if (!result.truncated) return result.content + feedback;
  const overflowPath =
    Buffer.byteLength(rawOutput, "utf-8") > MAX_BYTES
      ? await writeOverflow(rawOutput, "bash").catch(() => null)
      : null;
  const overflowNotice = overflowPath
    ? ` Full output saved to ${overflowPath} — read it with offset/limit if needed.`
    : "";
  const c = compressToolOutput(rawOutput);
  const what = describeCompressed(rawOutput, c.content);
  return `[${c.notice}${what ? ` ${what}` : ""}${overflowNotice}]\n${c.content}${feedback}`;
}

const BashParams = z.object({
  command: z.string(),
  review: z.boolean().optional().describe("Append git diff after a passing final check"),
  timeout: z.number().int().min(1000).optional(),
  run_in_background: z.boolean().optional(),
  persist: z.boolean().optional().describe("Keep cd/env across calls"),
  wake: z
    .object({
      pattern: z.string().min(1).max(200).optional(),
      silence_seconds: z.number().int().min(10).max(3600).optional(),
    })
    .refine((rules) => rules.pattern !== undefined || rules.silence_seconds !== undefined, {
      message: "Provide wake.pattern, wake.silence_seconds, or both.",
    })
    .optional()
    .describe("Notify on output match or silence"),
});

export function createBashTool(
  cwd: string,
  processManager: ProcessManager,
  ops: ToolOperations = localOperations,
  planModeRef?: { current: boolean },
  shellOpts?: ResolveShellOpts,
  getNetworkPolicy?: GetNetworkPolicy,
  getSandboxPolicy?: () => SandboxPolicy,
  /** Default foreground budget; injectable so tests need not wait 120s. */
  defaultTimeoutMs: number = DEFAULT_TIMEOUT,
): AgentTool<typeof BashParams> {
  // Lazily created on the first persist:true call; one session per tool
  // instance (i.e. per agent session), killed when the process exits.
  let sessionShell: PersistentShell | null = null;
  /** Install commands the model re-ran after a typosquat warning. */
  const confirmedInstalls = new Set<string>();
  let sessionSandboxKey: string | null = null;
  let sessionSandboxed = false;
  // Shell selection doesn't depend on the command, so resolve ONCE at tool
  // creation and bake the true execution environment into the description —
  // promising bash on a cmd.exe fallback makes the model write POSIX commands
  // that all fail. The runtime output banner below stays as belt-and-braces
  // for mid-session PATH changes.
  const isCmdFallback = resolveShell("", shellOpts ?? {}).isCmdFallback;
  const description = isCmdFallback
    ? "Run a Windows cmd.exe command (no bash on this system) in the project root. Use cmd " +
      "syntax (dir, findstr, type); POSIX commands and $(...) fail. Output tail is kept."
    : "Run a non-interactive bash command (TERM=dumb, pipefail) in the project root.";
  return {
    name: "bash",
    description:
      description +
      " Servers/watchers/REPLs: run_in_background + wake.pattern, then task_output wait_ms; " +
      "never `&`, nohup or sleep. Leave servers running. Kill by exact PID.",
    parameters: BashParams,
    executionMode: "sequential",
    async execute(
      { command, timeout: timeoutMs, run_in_background, persist, wake, review },
      context,
    ) {
      if (
        review &&
        (persist ||
          run_in_background ||
          ops !== localOperations ||
          !classifyVerificationCommand(command).accepted)
      ) {
        return REVIEW_REJECTED_BEFORE_START;
      }
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
      // A long sleep-only foreground call while something runs in the
      // background is a guessed wait: too short wastes a turn, too long wastes
      // wall-clock. Redirect rather than run it — descriptions alone do not
      // reliably beat the habit. Brief sleeps stay allowed, because letting a
      // just-started dev server settle before curling it is legitimate and no
      // exit is ever coming for it.
      const napSeconds = run_in_background ? null : sleepOnlySeconds(command);
      if (napSeconds !== null && napSeconds >= GUESSED_WAIT_SECONDS) {
        const running = processManager.list().filter((proc) => proc.exitCode === null);
        if (running.length > 0) {
          const ids = running.map((proc) => proc.id).join(", ");
          return (
            `Error: refusing to sleep ${napSeconds}s while ${running.length} background ` +
            `process(es) are running (${ids}). Sleeping guesses at a finish time. Call ` +
            `task_output with wait_ms instead \u2014 it returns on exit or a declared wake. ` +
            `For something that never exits, such as a dev server, run it with a wake ` +
            `pattern and wait for that line.`
          );
        }
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
      // Destructive-git guard — refuses reset --hard / checkout -- / restore /
      // clean -f / stash drop / branch -D / force push when work would be lost.
      // A persist:true call runs wherever the session shell last cd'd to.
      const liveShell = persist && process.platform !== "win32" ? sessionShell : null;
      const gitBlocked = await checkDestructiveGit(command, {
        cwd,
        resolveCwd:
          liveShell && !liveShell.isBusy
            ? async () => (await liveShell.run("pwd", 2_000, context.signal)).output.trim() || null
            : undefined,
      });
      if (gitBlocked) {
        return `Error: ${gitBlocked}`;
      }
      // Shell-threat guard — pipe-to-shell, reverse shells, secret exfiltration,
      // lookalike hosts and terminal-escape tricks (core/shell-threats.ts).
      const threatBlocked = shellThreatBlockMessage(command);
      if (threatBlocked) {
        return `Error: ${threatBlocked}`;
      }
      // Package-install guard: known malware (OSV, fail-open) is refused;
      // a likely typosquat is stopped once and allowed on an identical retry.
      const packageThreats = await checkPackageInstall(command, { signal: context.signal });
      const malware = packageThreats.find((threat) => threat.severity === "block");
      if (malware) {
        return `Error: Blocked by package safety check (${malware.rule}): ${malware.detail}`;
      }
      const typosquats = packageThreats.filter((threat) => threat.severity === "warn");
      if (typosquats.length > 0 && !confirmedInstalls.has(command)) {
        confirmedInstalls.add(command);
        return (
          `Error: not run — ${typosquats.map((threat) => threat.detail).join("; ")}. ` +
          `If this really is the package you want, run the exact same command again.`
        );
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
              args: ["--norc", "--noprofile", "-o", "pipefail"],
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
        if (context.signal.aborted) return CANCELLED_BEFORE_START;
        const res = await sessionShell.run(
          command,
          timeoutMs ?? DEFAULT_TIMEOUT,
          context.signal,
          context.onUpdate
            ? (text) => context.onUpdate?.({ type: "bash_progress", output: text, totalBytes: 0 })
            : undefined,
        );
        const output = await renderBashOutput(res.output, command, !isCmdFallback);
        const exitCode =
          res.exitCode === "TIMEOUT"
            ? `TIMEOUT (${timeoutMs ?? DEFAULT_TIMEOUT}ms)` +
              (res.shellKept
                ? " — the command was stopped; the session shell kept its cwd/env"
                : "")
            : String(res.exitCode);
        // The restart note sits right under the exit code so output truncation
        // can never drop it.
        const restartNote = sessionShell.takeRestartNote();
        const note = restartNote ? `${restartNote}\n` : "";
        return annotateSandboxDenial(`Exit code: ${exitCode}\n${note}${output}`, sessionSandboxed);
      }
      if (run_in_background) {
        let launch: SandboxLaunch;
        try {
          launch = await prepareLaunch(resolveShell(command, shellOpts));
        } catch (error) {
          return `Error: OS sandbox unavailable; command was not run: ${(error as Error).message}`;
        }
        if (context.signal.aborted) return CANCELLED_BEFORE_START;
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

      const effectiveTimeout = timeoutMs ?? defaultTimeoutMs;

      // Cross-platform shell: bash on macOS/Linux, Git Bash on Windows (or
      // cmd.exe fallback), wrapped by the OS sandbox before any child starts.
      const shell = resolveShell(command, shellOpts);
      let launch: SandboxLaunch;
      try {
        launch = await prepareLaunch(shell);
      } catch (error) {
        return `Exit code: 1\nOS sandbox unavailable; command was not run: ${(error as Error).message}`;
      }
      // Stop may have landed while the launch was being prepared. The abort
      // listener below would never fire for an already-aborted signal.
      if (context.signal.aborted) return CANCELLED_BEFORE_START;

      const result = await new Promise<string>((resolve, reject) => {
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
        let backgrounded = false;
        const startedAt = Date.now();

        /**
         * Hand a still-running command to the process manager instead of
         * killing it, so a slow build or test run keeps going (same process,
         * same cwd) while the agent moves on. Only for the default budget: an
         * explicit `timeout` is the model saying when to give up. Returns
         * false when adoption is not possible, leaving the kill path to run.
         */
        const moveToBackground = (): boolean => {
          // The shell already exited and only leftovers hold the pipes; the
          // drain path owns that case.
          if (timeoutMs !== undefined || child.exitCode !== null || !child.pid) return false;
          child.stdout?.off("data", onData);
          child.stderr?.off("data", onData);
          let adopted: ReturnType<ProcessManager["adopt"]>;
          try {
            adopted = processManager.adopt(child, command, startedAt, Buffer.concat(chunks));
          } catch {
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            return false;
          }
          backgrounded = true;
          context.signal.removeEventListener("abort", onAbort);
          void (async () => {
            const soFar = await renderBashOutput(Buffer.concat(chunks).toString("utf-8"));
            resolve(
              `Still running after ${effectiveTimeout / 1000}s, so it was moved to the background ` +
                `instead of being stopped. It keeps its working directory and output.\n` +
                `ID: ${adopted.id}\n` +
                `PID: ${adopted.pid}\n` +
                `Log: ${adopted.logFile}\n` +
                `You will be notified when it exits. Use task_output with id="${adopted.id}" ` +
                `(wait_ms to block until it exits) to read output, task_stop to stop it. ` +
                `Pass an explicit timeout to have a command stopped instead.\n` +
                (soFar ? `Output so far:\n${soFar}` : "No output so far."),
            );
          })();
          return true;
        };

        // Timeout handling
        const timer = setTimeout(() => {
          if (moveToBackground()) return;
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

        // "close" waits for every holder of the stdout/stderr pipes, and a
        // process the command left running (`cmd &`, `nohup cmd`) inherits them,
        // so without this the call hangs until the timeout. Once the shell
        // itself exits, let late output drain briefly, then stop the leftovers
        // and release the pipes so "close" fires.
        let leftover: "stopped" | "detached" | undefined;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        child.on("exit", () => {
          drainTimer = setTimeout(() => {
            leftover = child.pid && killLeftoverGroup(child.pid) ? "stopped" : "detached";
            child.stdout?.destroy();
            child.stderr?.destroy();
          }, LEFTOVER_DRAIN_MS);
        });

        child.on("close", async (code) => {
          clearTimeout(timer);
          clearTimeout(drainTimer);
          context.signal.removeEventListener("abort", onAbort);
          // The process manager owns an adopted command's exit.
          if (backgrounded) return;

          const rawOutput = Buffer.concat(chunks).toString("utf-8");
          let output = await renderBashOutput(rawOutput, command, !shell.isCmdFallback);
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
          if (leftover && !killed) {
            const fate =
              leftover === "stopped"
                ? "so it was stopped"
                : "so its later output was not captured; it may still be running";
            output =
              `[The command exited, but a process it left running in the background ` +
              `(& or nohup) still held its output ${LEFTOVER_DRAIN_MS / 1000}s later, ${fate}. ` +
              `Use run_in_background=true for anything that should keep running.]\n` +
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
          if (backgrounded) return;
          clearTimeout(timer);
          clearTimeout(drainTimer);
          context.signal.removeEventListener("abort", onAbort);
          reject(new Error(`Exit code: 1\nFailed to spawn: ${err.message}`));
        });
      });
      if (!review || context.signal.aborted || !/^Exit code: 0(?:\s|$)/.test(result)) return result;
      const inspection = await collectVerificationReview(cwd, context.signal);
      return `${result}\n\n--- Independent read-only review ---\n${await renderBashOutput(inspection)}`;
    },
  };
}
