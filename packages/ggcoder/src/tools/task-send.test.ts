import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessManager, type BackgroundProcess } from "../core/process-manager.js";
import { createTaskSendTool } from "./task-send.js";
import { createTaskOutputTool } from "./task-output.js";

async function waitForOutput(
  manager: ProcessManager,
  id: string,
  predicate: (output: string) => boolean,
): Promise<string> {
  let combined = "";
  for (let i = 0; i < 50; i += 1) {
    const result = await manager.readOutput(id);
    combined += result.output;
    if (predicate(combined)) return combined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for output. Saw:\n${combined}`);
}

describe("interactive background processes (task_send)", () => {
  let manager: ProcessManager;

  afterEach(() => {
    manager?.shutdownAll();
  });

  it("answers an interactive prompt and completes", async () => {
    manager = new ProcessManager();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-task-send-"));

    // Programs that print their prompt explicitly (echo) are visible over a
    // pipe; bash's `read -p` writes its prompt only to a tty, so use echo here.
    const started = await manager.start('echo "Name:"; read n; echo "HELLO_$n"', tmpDir);

    await waitForOutput(manager, started.id, (o) => o.includes("Name:"));

    const sendResult = await manager.sendInput(started.id, "world");
    expect(sendResult).toContain("Sent input");

    const out = await waitForOutput(manager, started.id, (o) => o.includes("HELLO_world"));
    expect(out).toContain("HELLO_world");
  }, 15_000);

  it("drives a REPL across multiple inputs", async () => {
    manager = new ProcessManager();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-task-send-repl-"));

    // A tiny line-reading loop that echoes back, then exits on EOF.
    const started = await manager.start(
      'while IFS= read -r line; do echo "GOT[$line]"; done',
      tmpDir,
    );

    await manager.sendInput(started.id, "first");
    await waitForOutput(manager, started.id, (o) => o.includes("GOT[first]"));

    await manager.sendInput(started.id, "second");
    await waitForOutput(manager, started.id, (o) => o.includes("GOT[second]"));

    // Closing stdin (EOF) ends the read loop and the process.
    await manager.sendInput(started.id, undefined, { eof: true });

    for (let i = 0; i < 50; i += 1) {
      const r = await manager.readOutput(started.id);
      if (!r.isRunning) {
        expect(r.exitCode).toBe(0);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Process did not exit after EOF");
  }, 15_000);

  it("returns a clear message when the process has already exited", async () => {
    manager = new ProcessManager();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-task-send-dead-"));

    const started = await manager.start('echo "done"', tmpDir);
    await waitForOutput(manager, started.id, (o) => o.includes("done"));
    // Give the close handler a tick to record the exit code.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const result = await manager.sendInput(started.id, "late");
    expect(result).toMatch(/already exited|not accepting input/);
  }, 15_000);

  it("reports unknown process ids", async () => {
    manager = new ProcessManager();
    const result = await manager.sendInput("nope", "hi");
    expect(result).toContain('No background process with id "nope"');
  });

  it("exposes a task_send tool that pairs with task_output", async () => {
    manager = new ProcessManager();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-task-send-tool-"));
    const sendTool = createTaskSendTool(manager);
    const outputTool = createTaskOutputTool(manager);

    expect(sendTool.name).toBe("task_send");

    const started = await manager.start('echo "Continue?"; read c; echo "ANSWER_$c"', tmpDir);
    await waitForOutput(manager, started.id, (o) => o.includes("Continue?"));

    const ctx = { signal: new AbortController().signal } as never;
    const sent = await sendTool.execute({ id: started.id, input: "yes" }, ctx);
    expect(sent).toContain("task_output");

    await waitForOutput(manager, started.id, (o) => o.includes("ANSWER_yes"));
    const result = await outputTool.execute({ id: started.id, from_start: true }, ctx);
    const content = typeof result === "string" ? result : result.content;
    expect(content).toContain("ANSWER_yes");
  }, 15_000);

  it("passes the exact independent text, newline, and EOF control matrix", async () => {
    const sendInput = vi.fn(async () => "sent");
    const sendTool = createTaskSendTool({ sendInput } as unknown as ProcessManager);
    const ctx = { signal: new AbortController().signal } as never;

    await sendTool.execute({ id: "bg", input: "text" }, ctx);
    await sendTool.execute({ id: "bg", input: "text", enter: false }, ctx);
    await sendTool.execute({ id: "bg", enter: true }, ctx);
    await sendTool.execute({ id: "bg", eof: true }, ctx);
    await sendTool.execute({ id: "bg", input: "text", enter: true, eof: true }, ctx);

    expect(sendInput.mock.calls).toEqual([
      ["bg", "text", { enter: undefined, eof: undefined }],
      ["bg", "text", { enter: false, eof: undefined }],
      ["bg", undefined, { enter: true, eof: undefined }],
      ["bg", undefined, { enter: undefined, eof: true }],
      ["bg", "text", { enter: true, eof: true }],
    ]);
    expect(sendTool.executionMode).toBe("sequential");
  });

  it("closes stdin for EOF-only without writing a hidden newline", async () => {
    manager = new ProcessManager();
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const received: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => received.push(chunk));
    const child = Object.assign(emitter, {
      pid: 4321,
      stdin,
      stdout: null,
      stderr: null,
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
    const proc: BackgroundProcess = {
      id: "eof-only",
      pid: 4321,
      command: "fixture",
      logFile: "fixture.log",
      startedAt: Date.now(),
      completedAt: null,
      exitCode: null,
      signal: null,
      lastReadOffset: null,
      logSize: 0,
    };
    const internals = manager as unknown as {
      processes: Map<string, BackgroundProcess>;
      children: Map<string, ChildProcess>;
    };
    internals.processes.set(proc.id, proc);
    internals.children.set(proc.id, child);

    const result = await createTaskSendTool(manager).execute({ id: proc.id, eof: true }, {
      signal: new AbortController().signal,
    } as never);

    expect(result).toContain("Closed stdin (EOF)");
    expect(stdin.writableEnded).toBe(true);
    expect(Buffer.concat(received).toString("utf8")).toBe("");
  });

  it("guards against empty sends", async () => {
    manager = new ProcessManager();
    const sendTool = createTaskSendTool(manager);
    const ctx = { signal: new AbortController().signal } as never;
    const result = await sendTool.execute({ id: "x", enter: false }, ctx);
    expect(result).toContain("Nothing to send");
  });
});
