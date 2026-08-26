/**
 * Session wiring for the verification gate: tool_call_end events must feed the
 * gate (edits/writes on code files, foreground verification commands), and the
 * pre-stop hook must block with the follow-up — once, then escalate, then go
 * silent. Drives the private hook directly, like agent-session-process-gate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@kenkaiiii/gg-ai";
import { useFakeHome } from "../test-support/fake-home.js";
import type { AgentEvent } from "@kenkaiiii/gg-agent";
import type { AgentSession } from "./agent-session.js";
import { ProcessManager } from "./process-manager.js";

interface GateInternals {
  processManager?: ProcessManager;
  runStartedAt: number;
  getHookFollowUpMessages(): Message[] | null;
  trackHookEvent(event: AgentEvent): Promise<void>;
  verificationGate: {
    recordMutation(): void;
    recordVerification(): void;
    isOwed(): boolean;
  };
  settingsManager: { set(key: string, value: unknown): Promise<void> };
}

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let session: AgentSession | undefined;
const managers: ProcessManager[] = [];

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-verify-gate-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-verify-gate-"));
  restoreHome = useFakeHome(tmpHome);
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-token",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.shutdownAll();
  await session?.dispose();
  session = undefined;
  restoreHome?.();
  // maxRetries: on Windows a just-reaped child's log handle can outlive the
  // process (background logs live under tmpHome), and a recursive rm then
  // fails with EBUSY.
  await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await fs.rm(tmpProject, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function makeSession(): Promise<GateInternals> {
  const { AgentSession: Session } = await import("./agent-session.js");
  session = new Session({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    transient: true,
    systemPrompt: "test",
    // Default selfCorrectionHooks (true) — the gate belongs to that family.
  });
  await session.initialize();
  return session as unknown as GateInternals;
}

/**
 * Wait for a background process to genuinely exit.
 *
 * A fixed budget is not a substitute: this test's whole claim is that the agent
 * read a FINISHED run, and `npm test` cold-starts in ~6s on the Windows runner
 * — past the 5s the old poll loop allowed, after which it silently continued
 * and asserted against a still-running process. Fail loudly instead.
 */
async function waitForExit(
  manager: ProcessManager,
  id: string,
  timeoutMs = 45_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proc = manager.list().find((entry) => entry.id === id);
    if (!proc) throw new Error(`Background process ${id} disappeared before it exited.`);
    if (proc.exitCode !== null) return proc.exitCode;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Background process ${id} did not exit within ${timeoutMs}ms.`);
}

let callSeq = 0;

async function simulateToolCall(
  internal: GateInternals,
  name: string,
  args: Record<string, unknown>,
  isError = false,
): Promise<void> {
  const toolCallId = `call-${++callSeq}`;
  await internal.trackHookEvent({
    type: "tool_call_start",
    toolCallId,
    name,
    args,
  } as unknown as AgentEvent);
  await internal.trackHookEvent({
    type: "tool_call_end",
    toolCallId,
    result: "",
    isError,
    durationMs: 1,
  } as unknown as AgentEvent);
}

describe("AgentSession verification gate", () => {
  it("blocks with a follow-up when code was edited but never verified", async () => {
    const internal = await makeSession();

    await simulateToolCall(internal, "bash", { command: "ls" });
    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", { command: "cat src/a.ts" });

    const followUp = internal.getHookFollowUpMessages();
    expect(followUp).not.toBeNull();
    expect(String(followUp![0]!.content)).toContain("src/a.ts");
    expect(String(followUp![0]!.content)).toContain("Run the project's verification");
  });

  it("stops blocking once a verification command runs after the edit", async () => {
    const internal = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", { command: "pnpm vitest run" });

    expect(internal.verificationGate.isOwed()).toBe(false);
    expect(internal.getHookFollowUpMessages()).toBeNull();
  });

  it("ignores edits to non-code files and background verification", async () => {
    const internal = await makeSession();

    await simulateToolCall(internal, "write", { file_path: "README.md" });
    expect(internal.verificationGate.isOwed()).toBe(false);

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", {
      command: "npm test",
      run_in_background: true,
    });
    expect(internal.verificationGate.isOwed()).toBe(true); // background ≠ verified
  });

  it("demands once, then lets the session stop instead of blocking again", async () => {
    const internal = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    const demand = internal.getHookFollowUpMessages()!;
    expect(String(demand[0]!.content)).toContain("Run the project's verification");

    // Second stop, still unverified: no further follow-up, so the run ends on
    // the model's next final answer rather than a third restated one.
    expect(internal.verificationGate.isOwed()).toBe(true);
    expect(internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.getHookFollowUpMessages()).toBeNull();
  });

  it("counts reading a finished background verification run as verification", async () => {
    const internal = await makeSession();
    const manager = new ProcessManager({ bgDir: path.join(tmpHome, "bg-verify") });
    managers.push(manager);
    internal.processManager = manager;

    // A real short verification-shaped process; it exits non-zero (empty dir),
    // which is fine — the agent SAW the result, that is what counts.
    const started = await manager.start("npm test", tmpProject);
    await waitForExit(manager, started.id);

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", {
      command: "npm test",
      run_in_background: true,
    });
    expect(internal.verificationGate.isOwed()).toBe(true); // background ≠ verified

    await simulateToolCall(internal, "task_output", { id: started.id });
    expect(internal.verificationGate.isOwed()).toBe(false); // read of the finished run
    // Longer than the 20s default: the assertion below is about a FINISHED run,
    // and npm's cold start on the Windows runner is measured in seconds.
  }, 60_000);

  it("is disabled by the verificationGateEnabled setting", async () => {
    const internal = await makeSession();
    await internal.settingsManager.set("verificationGateEnabled", false);

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    expect(internal.getHookFollowUpMessages()).toBeNull();
  });
});
