import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import { ProcessManager } from "./process-manager.js";

interface GateInternals {
  processManager?: ProcessManager;
  runStartedAt: number;
  processGateInjected: number;
  subAgentManager?: { completionGateMessage(): string | undefined };
  getHookFollowUpMessages(): Promise<Message[] | null>;
}

function makeSession(): { session: AgentSession; internal: GateInternals } {
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-sonnet-5",
    cwd: "/project",
    transient: true,
    systemPrompt: "test",
    // Isolate the process gate from the Ideal review phase.
    selfCorrectionHooks: false,
  });
  return { session, internal: session as unknown as GateInternals };
}

const managers: ProcessManager[] = [];

function trackedManager(): ProcessManager {
  // Own log dir: start() prunes bgDir, whose default is the real ~/.gg/bg.
  const manager = new ProcessManager({
    bgDir: mkdtempSync(path.join(os.tmpdir(), "gg-bg-gate-")),
  });
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdownAll();
});

/** Poll until the process log has content, so the read is meaningful. */
async function waitForOutput(manager: ProcessManager, id: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await manager.readOutput(id);
    if (result.output.trim()) return result.output;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "";
}

describe("AgentSession background-process completion gate", () => {
  it("injects once for an unread in-run process, then completes after it is read", async () => {
    const { internal } = makeSession();
    const manager = trackedManager();
    internal.processManager = manager;
    internal.runStartedAt = Date.now();

    const started = await manager.start("echo gate-probe; sleep 30", process.cwd());

    const first = await internal.getHookFollowUpMessages();
    expect(first?.[0]?.role).toBe("user");
    expect(first?.[0]?.content).toContain(started.id);
    expect(internal.processGateInjected).toBe(1);

    // The agent does what the gate asked: reads the output.
    expect(await waitForOutput(manager, started.id)).toContain("gate-probe");

    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.processGateInjected).toBe(1);
  });

  it("never gates a process that predates the run", async () => {
    const { internal } = makeSession();
    const manager = trackedManager();
    internal.processManager = manager;

    await manager.start("sleep 30", process.cwd());
    // Run started after the process — a deliberately long-lived dev server.
    internal.runStartedAt = Date.now() + 1_000;

    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.processGateInjected).toBe(0);
  });

  it("stops gating after the per-run injection cap so a turn can never wedge", async () => {
    const { internal } = makeSession();
    const manager = trackedManager();
    internal.processManager = manager;
    internal.runStartedAt = Date.now();

    await manager.start("sleep 30", process.cwd());

    expect(await internal.getHookFollowUpMessages()).not.toBeNull();
    expect(await internal.getHookFollowUpMessages()).not.toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.processGateInjected).toBe(2);
  });

  it("sends the child-agent and process gates in one follow-up: one forced turn, not two", async () => {
    const { internal } = makeSession();
    const manager = trackedManager();
    internal.processManager = manager;
    internal.runStartedAt = Date.now();
    let childPending = true;
    internal.subAgentManager = {
      completionGateMessage: () =>
        childPending ? "Collect child agent recovered-child before finishing." : undefined,
    };

    const started = await manager.start("echo both-probe; sleep 30", process.cwd());

    // Simulated model: each forced turn does everything the follow-up asks.
    let forcedTurns = 0;
    for (let stop = 0; stop < 5; stop++) {
      const messages = await internal.getHookFollowUpMessages();
      if (!messages) break;
      forcedTurns += 1;
      const text = messages.map((m) => String(m.content)).join("\n");
      if (text.includes("recovered-child")) childPending = false;
      if (text.includes(started.id)) await waitForOutput(manager, started.id);
    }

    expect(forcedTurns).toBe(1);
    expect(internal.processGateInjected).toBe(1);
  });
});
