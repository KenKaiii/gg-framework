import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ProcessManager } from "../core/process-manager.js";
import type { BashToolResultDetails } from "../types.js";
import { createBashTool } from "./bash.js";
import { createTaskOutputTool, type TaskOutputToolResultDetails } from "./task-output.js";
import { createTaskSendTool } from "./task-send.js";
import {
  localOperations,
  type ProcessLifecycleAdapter,
  type SpawnProcessOptions,
  type ToolOperations,
} from "./operations.js";

interface FakeChildProcess extends ChildProcess {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
}

interface CommandHarness {
  child: FakeChildProcess;
  manager: ProcessManager;
  ops: ToolOperations;
  spawn: ReturnType<typeof vi.fn<ProcessLifecycleAdapter["spawn"]>>;
  cleanupProcessTree: ReturnType<typeof vi.fn<ProcessLifecycleAdapter["cleanupProcessTree"]>>;
  killProcessTree: ReturnType<typeof vi.fn<ProcessLifecycleAdapter["killProcessTree"]>>;
  stdinBytes: () => string;
  cleanup: () => Promise<void>;
}

const toolContext = () =>
  ({ signal: new AbortController().signal, toolCallId: "bash-mode-contract" }) as never;

function resultContent(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null && "content" in result) {
    const { content } = result as { content: unknown };
    if (typeof content === "string") return content;
  }
  throw new Error("Expected text tool output");
}

async function createHarness(): Promise<CommandHarness> {
  const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gg-bash-mode-"));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let writtenToStdin = "";
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writtenToStdin += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      callback();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 42_424,
    exitCode: null,
    signalCode: null,
    stdin,
    stdout,
    stderr,
    unref: vi.fn(),
  }) as unknown as FakeChildProcess;
  const spawn = vi.fn<ProcessLifecycleAdapter["spawn"]>(() => child);
  const cleanupProcessTree = vi.fn<ProcessLifecycleAdapter["cleanupProcessTree"]>(async () => {});
  const killProcessTree = vi.fn<ProcessLifecycleAdapter["killProcessTree"]>();
  const lifecycle: ProcessLifecycleAdapter = {
    spawn,
    cleanupProcessTree,
    killProcessTree,
    reapProcessWrapper: vi.fn(),
  };
  const manager = new ProcessManager(lifecycle, undefined, {
    backgroundLogRoot: path.join(logRoot, "background"),
    foregroundLogRoot: path.join(logRoot, "foreground"),
    createExecutionId: () => "deadbeef",
  });
  const ops: ToolOperations = { ...localOperations, process: lifecycle };

  return {
    child,
    manager,
    ops,
    spawn,
    cleanupProcessTree,
    killProcessTree,
    stdinBytes: () => writtenToStdin,
    cleanup: async () => {
      manager.shutdownAll();
      stdin.end();
      stdout.destroy();
      stderr.destroy();
      await fs.rm(logRoot, { recursive: true, force: true });
    },
  };
}

function completeChild(
  child: FakeChildProcess,
  output: string,
  exitCode = 0,
  signal: NodeJS.Signals | null = null,
): void {
  child.stdout.end(output);
  child.stderr.end();
  const mutableChild = child as unknown as {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  mutableChild.exitCode = exitCode;
  mutableChild.signalCode = signal;
  child.emit("close", exitCode, signal);
}

const backgroundCommands = [
  { commandClass: "Vite dev server", command: "pnpm vite" },
  { commandClass: "Next dev server", command: "pnpm next dev" },
  { commandClass: "watch command", command: "pnpm vitest --watch" },
  { commandClass: "REPL", command: "node" },
  { commandClass: "input-waiting scaffolder", command: "pnpm create vite" },
] as const;

const foregroundCommands = [
  { commandClass: "vitest run", command: "pnpm exec vitest run", timeoutMs: 120_000 },
  { commandClass: "build", command: "pnpm build", timeoutMs: 120_000 },
  { commandClass: "lint", command: "pnpm lint", timeoutMs: 120_000 },
  { commandClass: "format", command: "pnpm format:check", timeoutMs: 120_000 },
  {
    commandClass: "migration",
    command: "pnpm prisma migrate deploy",
    timeoutMs: 120_000,
  },
  {
    commandClass: "one-shot script with timeout override",
    command: "node scripts/once.mjs",
    timeoutMs: 4_500,
  },
] as const;

describe("bash explicit command modes", () => {
  describe.each(foregroundCommands)("foreground $commandClass", ({ command, timeoutMs }) => {
    it("waits for final status with ignored stdin and structured timeout diagnostics", async () => {
      const harness = await createHarness();
      try {
        const tool = createBashTool(process.cwd(), harness.manager, harness.ops);
        const args = timeoutMs === 120_000 ? { command } : { command, timeout: timeoutMs };
        let settled = false;
        const execution = Promise.resolve(tool.execute(args, toolContext())).then((result) => {
          settled = true;
          return result;
        });

        await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
        expect(harness.spawn.mock.calls[0]?.[2]).toMatchObject({
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        } satisfies Partial<SpawnProcessOptions>);
        expect(settled).toBe(false);
        expect(harness.stdinBytes()).toBe("");

        completeChild(harness.child, `finished: ${command}`);
        const result = await execution;
        const content = resultContent(result);

        expect(content).toContain("Exit code: 0");
        expect(content).toContain(`finished: ${command}`);
        expect(typeof result).toBe("object");
        if (typeof result !== "string") {
          const details = result.details as BashToolResultDetails | undefined;
          expect(details?.bashDiagnostics).toMatchObject({
            command,
            timeoutMs,
            reason: "completed",
            exitCode: 0,
          });
        }
      } finally {
        await harness.cleanup();
      }
    });
  });

  it("kills a persistent shell synchronously during process-manager shutdown", async () => {
    const harness = await createHarness();
    try {
      const tool = createBashTool(process.cwd(), harness.manager, harness.ops);
      const execution = Promise.resolve(
        tool.execute({ command: "printf managed", persist: true }, toolContext()),
      );

      await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
      harness.manager.shutdownAll();

      expect(harness.killProcessTree).toHaveBeenCalledOnce();
      expect(harness.killProcessTree).toHaveBeenCalledWith({
        pid: 42_424,
        isExited: expect.any(Function),
      });
      expect(harness.cleanupProcessTree).not.toHaveBeenCalled();

      const mutableChild = harness.child as unknown as {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      mutableChild.signalCode = "SIGTERM";
      harness.child.emit("exit", null, "SIGTERM");
      await execution;
    } finally {
      await harness.cleanup();
    }
  });

  describe.each(backgroundCommands)("background $commandClass", ({ command }) => {
    it("returns managed metadata after spawn and stays interactive and observable", async () => {
      const harness = await createHarness();
      try {
        const bashTool = createBashTool(process.cwd(), harness.manager, harness.ops);
        let initiatingCallSettled = false;
        const initiatingCall = Promise.resolve(
          bashTool.execute({ command, run_in_background: true }, toolContext()),
        ).then((result) => {
          initiatingCallSettled = true;
          return result;
        });

        await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledTimes(1));
        expect(harness.spawn.mock.calls[0]?.[2]).toMatchObject({
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        } satisfies Partial<SpawnProcessOptions>);
        expect(initiatingCallSettled).toBe(false);

        harness.child.emit("spawn");
        const startResult = await initiatingCall;
        const startContent = resultContent(startResult);
        const id = startContent.match(/ID: ([a-f0-9]{8})/)?.[1];

        expect(id).toBeDefined();
        expect(startContent).toContain("PID: 42424");
        expect(startContent).toMatch(/Log: .+\.log/);
        expect(startContent).toContain("task_output");
        expect(startContent).toContain("task_send");
        expect(startContent).toContain("task_stop");
        expect(harness.child.unref).toHaveBeenCalledOnce();
        expect(harness.child.exitCode).toBeNull();

        const sendTool = createTaskSendTool(harness.manager);
        const sendResult = await sendTool.execute({ id: id!, input: "confirmed" }, toolContext());
        expect(sendResult).toContain("Sent input");
        expect(harness.stdinBytes()).toBe("confirmed\n");

        completeChild(harness.child, `later output: ${command}`);
        const outputTool = createTaskOutputTool(harness.manager);
        let laterResult: Awaited<ReturnType<typeof outputTool.execute>> | undefined;
        await vi.waitFor(async () => {
          laterResult = await outputTool.execute({ id: id!, from_start: true }, toolContext());
          const content = typeof laterResult === "string" ? laterResult : laterResult.content;
          expect(content).toContain(`later output: ${command}`);
          expect(content).toContain(`Process ${id}: exited (code 0, completed `);
        });

        expect(laterResult).toBeDefined();
        if (laterResult && typeof laterResult !== "string") {
          const details = laterResult.details as TaskOutputToolResultDetails | undefined;
          expect(details?.taskOutput).toMatchObject({
            isRunning: false,
            exitCode: 0,
            signal: null,
            completedAt: expect.any(Number),
          });
        }
      } finally {
        await harness.cleanup();
      }
    });
  });
});
