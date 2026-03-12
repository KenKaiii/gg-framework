import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import { killProcessTree } from "../utils/process.js";
import { truncateTail } from "./truncate.js";

const DEFAULT_TIMEOUT = 120_000; // 120 seconds
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB — cap buffered output to prevent OOM

/** Environment variables safe to inherit. Everything else is stripped to prevent leaking secrets to LLM. */
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "NO_COLOR",
  "FORCE_COLOR",
  // Development toolchains
  "NODE_PATH",
  "NVM_DIR",
  "NPM_CONFIG_PREFIX",
  "PNPM_HOME",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PYENV_ROOT",
  "VIRTUAL_ENV",
  "CONDA_DEFAULT_ENV",
  "CONDA_PREFIX",
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "RUBY_VERSION",
  "GEM_HOME",
  "RBENV_ROOT",
]);

function getSafeEnv(): Record<string, string> {
  const env: Record<string, string> = { TERM: "dumb" };
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
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
});

export function createBashTool(
  cwd: string,
  processManager: ProcessManager,
): AgentTool<typeof BashParams> {
  return {
    name: "bash",
    description:
      "Execute a bash command. The shell's working directory is already set to the project root — " +
      "don't cd into it redundantly. Use cd only when you need a different directory. " +
      "Returns exit code and combined stdout/stderr. " +
      "Commands run in a non-interactive bash shell with TERM=dumb. " +
      "Long output is truncated (tail kept). " +
      "Set run_in_background=true for long-running processes (dev servers, watchers). " +
      "Use task_output/task_stop to interact with background processes.",
    parameters: BashParams,
    async execute({ command, timeout: timeoutMs, run_in_background }, context) {
      if (run_in_background) {
        const result = await processManager.start(command, cwd);
        return (
          `Background process started.\n` +
          `ID: ${result.id}\n` +
          `PID: ${result.pid}\n` +
          `Log: ${result.logFile}\n` +
          `Use task_output with id="${result.id}" to read output.`
        );
      }

      const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT;

      return new Promise<string>((resolve) => {
        const child = spawn("bash", ["-c", command], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: getSafeEnv(),
        });

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let outputCapped = false;

        const onData = (data: Buffer) => {
          if (outputCapped) return;
          totalBytes += data.length;
          if (totalBytes > MAX_OUTPUT_BYTES) {
            outputCapped = true;
            // Keep what we have — it'll be truncated by truncateTail anyway
            return;
          }
          chunks.push(data);
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
          if (outputCapped) {
            output = `[Output capped at ${MAX_OUTPUT_BYTES / 1024 / 1024} MB to prevent memory exhaustion]\n${output}`;
          }
          if (result.truncated) {
            // Save full output to temp file
            const tmpPath = path.join(os.tmpdir(), `gg-bash-${Date.now()}.txt`);
            await fs.writeFile(tmpPath, rawOutput, "utf-8").catch(() => {});
            output = `[Truncated: showing last ${result.keptLines} of ${result.totalLines} lines. Full output: ${tmpPath}]\n${output}`;
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
