import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessManager } from "./process-manager.js";

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

async function waitForProcessExit(pid: number): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Process ${pid} was still alive after shutdown.`);
}

/**
 * Terminate a real spawned process group with the *unmocked* process.kill.
 * Used by tests that stub the manager's kill machinery and would otherwise
 * leak the OS process they spawned. POSIX kills the detached group (-pid);
 * Windows falls back to the single pid.
 */
function killRealProcessTree(pid: number): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseGrandchildPid(output: string): number {
  const match = output.match(/GRANDCHILD_READY (\d+)/);
  if (!match) throw new Error(`No grandchild pid in output:\n${output}`);
  return Number(match[1]);
}

describe("ProcessManager dev-server lifecycle repro", () => {
  let manager: ProcessManager;

  afterEach(() => {
    manager?.shutdownAll();
  });

  it("scrubs unsafe inherited environment for background commands", async () => {
    const oldSecret = process.env.GG_TEST_SHOULD_NOT_LEAK;
    process.env.GG_TEST_SHOULD_NOT_LEAK = "super-secret";
    manager = new ProcessManager();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-bg-env-"));
    try {
      const started = await manager.start(
        `${JSON.stringify(process.execPath)} -e "console.log(process.env.GG_TEST_SHOULD_NOT_LEAK || 'scrubbed')"`,
        tmpDir,
      );
      const output = await waitForOutput(manager, started.id, (text) => text.includes("scrubbed"));
      expect(output).toContain("scrubbed");
      expect(output).not.toContain("super-secret");
    } finally {
      if (oldSecret === undefined) delete process.env.GG_TEST_SHOULD_NOT_LEAK;
      else process.env.GG_TEST_SHOULD_NOT_LEAK = oldSecret;
    }
  });

  it("uses taskkill for Windows process-tree shutdown fallback", async () => {
    const taskkill = vi.fn();
    manager = new ProcessManager({
      platform: "win32",
      kill: vi.fn(() => {
        throw new Error("force fallback");
      }) as typeof process.kill,
      spawnSync: taskkill as never,
    });
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-win-taskkill-"));
    const started = await manager.start(
      `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`,
      tmpDir,
    );
    try {
      const stopped = await manager.stop(started.id);
      expect(stopped).toBe(`Process ${started.id} already exited`);
      manager.shutdownAll();
      expect(taskkill).toHaveBeenCalledWith("taskkill", ["/pid", String(started.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } finally {
      // This test deliberately mocks `kill` and `spawnSync`, so neither the
      // simulated stop() nor shutdownAll() actually signals the real child
      // spawned by start(). Reap it for real here — otherwise every run of
      // this suite orphans a live `node -e setInterval` process forever.
      killRealProcessTree(started.pid);
    }
  });

  it("starts, reads, and stops a long-running Node HTTP server through the worker background path", async () => {
    manager = new ProcessManager();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-dev-server-repro-"));
    const fixture = path.join(tmpDir, "dev-server.mjs");
    await fs.writeFile(
      fixture,
      `import http from 'node:http';\n` +
        `const server = http.createServer((_req, res) => res.end('ok'));\n` +
        `server.listen(0, '127.0.0.1', () => {\n` +
        `  const address = server.address();\n` +
        `  console.log('DEV_SERVER_READY ' + address.port);\n` +
        `});\n` +
        `const interval = setInterval(() => console.log('DEV_SERVER_TICK'), 250);\n` +
        `process.on('SIGTERM', () => {\n` +
        `  console.log('DEV_SERVER_SIGTERM');\n` +
        `  clearInterval(interval);\n` +
        `  server.close(() => process.exit(0));\n` +
        `});\n`,
    );

    const started = await manager.start(`${process.execPath} ${fixture}`, tmpDir);
    expect(started.pid).toBeGreaterThan(0);
    expect(started.logFile).toMatch(/\.log$/);

    const initial = await waitForOutput(manager, started.id, (output) =>
      output.includes("DEV_SERVER_READY"),
    );
    expect(initial).toContain("DEV_SERVER_READY");

    const fromStart = await manager.readOutput(started.id, true);
    expect(fromStart.isRunning).toBe(true);
    expect(fromStart.exitCode).toBeNull();
    expect(fromStart.output).toContain("DEV_SERVER_READY");

    const stopped = await manager.stop(started.id);
    expect(stopped).toBe(`Process ${started.id} stopped`);

    const final = await manager.readOutput(started.id, true);
    expect(final.isRunning).toBe(false);
    expect(final.exitCode).not.toBeNull();
    expect(final.output).toContain("DEV_SERVER_SIGTERM");
  }, 15_000);

  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt(
    "kills the whole detached process group on POSIX/WSL shutdown",
    async () => {
      manager = new ProcessManager();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-posix-process-group-"));
      const childFixture = path.join(tmpDir, "grandchild.mjs");
      const parentFixture = path.join(tmpDir, "parent.mjs");

      await fs.writeFile(
        childFixture,
        `console.log('GRANDCHILD_READY ' + process.pid);\n` + `setInterval(() => {}, 1000);\n`,
      );
      await fs.writeFile(
        parentFixture,
        `import { spawn } from 'node:child_process';\n` +
          `const child = spawn(process.execPath, [${JSON.stringify(childFixture)}], { stdio: ['ignore', 'inherit', 'inherit'] });\n` +
          `console.log('PARENT_READY ' + process.pid + ' child=' + child.pid);\n` +
          `setInterval(() => {}, 1000);\n`,
      );

      const started = await manager.start(
        `${JSON.stringify(process.execPath)} ${JSON.stringify(parentFixture)}`,
        tmpDir,
      );
      const output = await waitForOutput(manager, started.id, (text) =>
        text.includes("GRANDCHILD_READY"),
      );
      const grandchildPid = parseGrandchildPid(output);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      manager.shutdownAll();

      await waitForProcessExit(grandchildPid);
      const final = await manager.readOutput(started.id, true);
      expect(final.isRunning).toBe(false);
      expect(final.output).toContain("PARENT_READY");
      expect(final.output).toContain("GRANDCHILD_READY");
    },
    15_000,
  );
});
