import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { killProcessTree } from "../utils/process.js";

export interface BackgroundProcess {
  id: string;
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
  exitCode: number | null;
  lastReadOffset: number;
}

export interface StartResult {
  id: string;
  pid: number;
  logFile: string;
}

export interface ReadOutputResult {
  id: string;
  isRunning: boolean;
  exitCode: number | null;
  output: string;
}

const BG_DIR = path.join(os.homedir(), ".gg", "bg");

export class ProcessManager {
  private processes = new Map<string, BackgroundProcess>();
  private children = new Map<string, ChildProcess>();

  async start(command: string, cwd: string): Promise<StartResult> {
    await fsp.mkdir(BG_DIR, { recursive: true });

    const id = crypto.randomUUID().slice(0, 8);
    const logFile = path.join(BG_DIR, `${id}.log`);
    const fd = fs.openSync(logFile, "w");

    const child = spawn("bash", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, TERM: "dumb" },
    });

    fs.closeSync(fd);

    const pid = child.pid!;
    child.unref();

    const proc: BackgroundProcess = {
      id,
      pid,
      command,
      logFile,
      startedAt: Date.now(),
      exitCode: null,
      lastReadOffset: 0,
    };

    this.processes.set(id, proc);
    this.children.set(id, child);

    child.on("close", (code) => {
      proc.exitCode = code ?? 1;
      this.children.delete(id);
    });

    return { id, pid, logFile };
  }

  async readOutput(id: string, fromStart?: boolean): Promise<ReadOutputResult> {
    const proc = this.processes.get(id);
    if (!proc) {
      return {
        id,
        isRunning: false,
        exitCode: null,
        output: `No background process with id "${id}"`,
      };
    }

    const offset = fromStart ? 0 : proc.lastReadOffset;
    let output = "";

    try {
      const stat = await fsp.stat(proc.logFile);
      if (stat.size > offset) {
        const buf = Buffer.alloc(stat.size - offset);
        const fh = await fsp.open(proc.logFile, "r");
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        await fh.close();
        output = buf.subarray(0, bytesRead).toString("utf-8");
        proc.lastReadOffset = offset + bytesRead;
      }
    } catch {
      output = "(failed to read log file)";
    }

    const isRunning = this.children.has(id);
    return { id, isRunning, exitCode: proc.exitCode, output };
  }

  async stop(id: string): Promise<string> {
    const proc = this.processes.get(id);
    if (!proc) return `No background process with id "${id}"`;

    const child = this.children.get(id);
    if (!child || proc.exitCode !== null) {
      return `Process ${id} already exited (code ${proc.exitCode})`;
    }

    // SIGTERM first
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try {
        process.kill(proc.pid, "SIGTERM");
      } catch {
        return `Process ${id} already exited`;
      }
    }

    // Wait up to 5s, then SIGKILL
    const exited = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      child.on("close", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });

    if (!exited) {
      killProcessTree(proc.pid);
    }

    return `Process ${id} stopped`;
  }

  list(): BackgroundProcess[] {
    return Array.from(this.processes.values());
  }

  shutdownAll(): void {
    for (const [id, proc] of this.processes) {
      if (this.children.has(id)) {
        killProcessTree(proc.pid);
      }
    }
    this.processes.clear();
    this.children.clear();
  }
}
