import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessManager, type WakeRules } from "../core/process-manager.js";
import { AgentNotificationQueue } from "../core/agent-notifications.js";
import { createTaskOutputTool } from "./task-output.js";

const managers: ProcessManager[] = [];
const directories: string[] = [];
const context = { signal: new AbortController().signal, toolCallId: "server-readiness" };

async function start(wake?: WakeRules) {
  const bgDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-task-output-"));
  directories.push(bgDir);
  const notifications = new AgentNotificationQueue();
  const manager = new ProcessManager({ bgDir, notifications });
  managers.push(manager);
  const process = await manager.start(
    "readiness test server",
    bgDir,
    {
      file: globalThis.process.execPath,
      args: [
        "-e",
        "const s=require('node:http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log('READY',s.address().port));",
      ],
      isCmdFallback: false,
    },
    wake,
  );
  return { manager, notifications, id: process.id, tool: createTaskOutputTool(manager) };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const process of manager.list()) await manager.stop(process.id);
    manager.shutdownAll();
  }
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("task_output readiness", () => {
  it("accepts a wait of up to 5 minutes and no longer", async () => {
    const { tool, id } = await start();
    expect(tool.parameters.safeParse({ id, wait_ms: 300_000 }).success).toBe(true);
    expect(tool.parameters.safeParse({ id, wait_ms: 300_001 }).success).toBe(false);
  });

  it("retains a wake fired before waiting, but does not replay it after reading", async () => {
    const { manager, tool, notifications, id } = await start({ pattern: /READY/ });
    expect(await manager.waitForExitOrWake(id, 15_000)).toBe("pattern");
    // Delivery to the agent and watcher retirement must not lose a pending wake.
    expect(notifications.drain().some((entry) => entry.text.includes("wake pattern"))).toBe(true);
    expect(String(await tool.execute({ id, wait_ms: 15_000 }, context))).toContain(
      "wake pattern matched",
    );
    expect(String(await tool.execute({ id, wait_ms: 1000 }, context))).toContain(
      "still running after waiting 1s",
    );
  });

  it("releases on silence without claiming the server is ready", async () => {
    const { tool, id } = await start({ silenceMs: 100 });
    const output = String(await tool.execute({ id, wait_ms: 15_000 }, context));
    expect(output).toContain("running — silence wake fired");
    expect(output).toContain("not necessarily ready");
  });

  it("does not treat unrelated output as a readiness match", async () => {
    const { tool, id } = await start({ pattern: /NEVER_MATCHES/ });
    const output = String(await tool.execute({ id, wait_ms: 1000 }, context));
    expect(output).toContain("still running after waiting 1s");
    expect(output).not.toContain("wake pattern matched");
  });

  it("releases a blocking wait when the server is ready, without stopping it", async () => {
    const { tool, id } = await start({ pattern: /READY/ });
    const output = String(await tool.execute({ id, wait_ms: 15_000 }, context));
    expect(output).toContain("running — wake pattern matched");
    expect(output).not.toContain("still running after waiting");
    const port = output.match(/READY (\d+)/)?.[1];
    expect(port).toBeDefined();
    const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
