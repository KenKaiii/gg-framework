import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@kleio/ai";
import { AgentSession } from "./agent-session.js";

interface SemanticInternals {
  settingsManager: { get(key: string): boolean };
  loopMonitor: {
    stats: { toolFailures: number; turns: number; toolCalls: number };
    consecutiveFailures: number;
    repeatedNoProgressCalls: number;
    recentCalls: { tool: string; args: string; ok: boolean; result: string }[];
    semanticLoop: {
      checksUsed: number;
      lastCheckTurn: number;
      pending: boolean;
      verdict: { loop: boolean; reason: string; advice: string } | null;
      injected: boolean;
    };
  };
  resetHookState(originalRequest: string): void;
  getHookSteeringMessages(): Message[] | null;
  trackHookEvent(event: Record<string, unknown>): Promise<void>;
}

const workspaces: string[] = [];
function makeWorkspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "gg-semantic-loop-"));
  workspaces.push(root);
  return root;
}

afterAll(() => {
  for (const root of workspaces) rmSync(root, { recursive: true, force: true });
});

function makeSession(judge: (prompt: string) => Promise<string>) {
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-sonnet-5",
    cwd: makeWorkspace(),
    transient: true,
    systemPrompt: "test",
    semanticLoopJudge: judge,
  });
  const internal = session as unknown as SemanticInternals;
  internal.settingsManager = { get: () => true };
  return internal;
}

/** Suspicious but syntactically quiet: consecutive failures, no repeat/cycle signal. */
function primeSuspicion(internal: SemanticInternals): void {
  internal.loopMonitor.stats = { toolFailures: 3, turns: 10, toolCalls: 8 };
  internal.loopMonitor.consecutiveFailures = 2;
  internal.loopMonitor.recentCalls = [
    { tool: "bash", args: '{"command":"npm test"}', ok: false, result: "Exit code: 1" },
    { tool: "edit", args: '{"file_path":"src/a.ts"}', ok: true, result: "ok" },
    { tool: "bash", args: '{"command":"npm test --filter x"}', ok: false, result: "Exit code: 1" },
  ];
}

describe("AgentSession semantic loop check", () => {
  it("starts the judge on a suspicious burst and injects its verdict at the next poll", async () => {
    const judge = vi.fn(
      async () =>
        '{"loop": true, "reason": "same failure, varying retries", "advice": "read the assertion"}',
    );
    const internal = makeSession(judge);
    primeSuspicion(internal);

    // First poll fires the judge in the background; no message yet.
    expect(internal.getHookSteeringMessages()).toBeNull();
    expect(judge).toHaveBeenCalledTimes(1);
    expect(internal.loopMonitor.semanticLoop.pending).toBe(true);
    await vi.waitFor(() => expect(internal.loopMonitor.semanticLoop.pending).toBe(false));

    const messages = internal.getHookSteeringMessages();
    expect(messages?.[0]?.content).toContain("unproductive pattern");
    expect(messages?.[0]?.content).toContain("same failure, varying retries");
    expect(internal.loopMonitor.semanticLoop.injected).toBe(true);
    // Addressed: the failure burst resets so a fresh burst must re-accumulate.
    expect(internal.loopMonitor.consecutiveFailures).toBe(0);

    // Once per run even if a second check later returns another loop verdict.
    internal.loopMonitor.semanticLoop.verdict = { loop: true, reason: "again", advice: "" };
    expect(internal.getHookSteeringMessages()).toBeNull();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores an old judge's %s after a new question starts",
    async (outcome) => {
      let resolve!: (value: string) => void;
      let reject!: (reason: Error) => void;
      const pending = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const internal = makeSession(() => pending);
      primeSuspicion(internal);
      internal.getHookSteeringMessages();
      expect(internal.loopMonitor.semanticLoop.pending).toBe(true);

      internal.resetHookState("Explain the previous change without editing anything");
      const freshState = { ...internal.loopMonitor.semanticLoop };
      if (outcome === "resolve") {
        resolve('{"loop": true, "reason": "old failure", "advice": "retry"}');
      } else {
        reject(new Error("old request failed"));
      }
      await new Promise<void>((done) => setImmediate(done));

      expect(internal.loopMonitor.semanticLoop).toEqual(freshState);
      expect(internal.getHookSteeringMessages()).toBeNull();
    },
  );

  it("keeps the current judge pending when an old judge finishes", async () => {
    let finishOld!: (value: string) => void;
    let finishCurrent!: (value: string) => void;
    const old = new Promise<string>((resolve) => {
      finishOld = resolve;
    });
    const current = new Promise<string>((resolve) => {
      finishCurrent = resolve;
    });
    const judge = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(current);
    const internal = makeSession(judge);
    primeSuspicion(internal);
    internal.getHookSteeringMessages();

    internal.resetHookState("Fix a different problem");
    primeSuspicion(internal);
    internal.getHookSteeringMessages();
    const freshState = { ...internal.loopMonitor.semanticLoop };
    finishOld('{"loop": true, "reason": "old failure", "advice": "retry"}');
    await new Promise<void>((done) => setImmediate(done));

    expect(internal.loopMonitor.semanticLoop).toEqual(freshState);
    expect(internal.getHookSteeringMessages()).toBeNull();
    expect(judge).toHaveBeenCalledTimes(2);
    finishCurrent('{"loop": true, "reason": "current failure", "advice": "inspect"}');
    await new Promise<void>((done) => setImmediate(done));
    expect(internal.loopMonitor.semanticLoop.pending).toBe(false);
    expect(internal.loopMonitor.semanticLoop.checksUsed).toBe(1);
    expect(internal.getHookSteeringMessages()?.[0]?.content).toContain("current failure");
  });

  it("fails open: a no-loop or unparseable verdict injects nothing", async () => {
    const internal = makeSession(async () => '{"loop": false, "reason": "", "advice": ""}');
    primeSuspicion(internal);
    expect(internal.getHookSteeringMessages()).toBeNull();
    await vi.waitFor(() => expect(internal.loopMonitor.semanticLoop.checksUsed).toBe(1));
    expect(internal.getHookSteeringMessages()).toBeNull();

    const broken = makeSession(async () => "the model could not answer");
    primeSuspicion(broken);
    broken.getHookSteeringMessages();
    await vi.waitFor(() => expect(broken.loopMonitor.semanticLoop.checksUsed).toBe(1));
    expect(broken.getHookSteeringMessages()).toBeNull();
  });

  it("judge errors never reject into the loop and still consume budget", async () => {
    const internal = makeSession(async () => {
      throw new Error("provider down");
    });
    primeSuspicion(internal);
    expect(internal.getHookSteeringMessages()).toBeNull();
    await vi.waitFor(() => expect(internal.loopMonitor.semanticLoop.checksUsed).toBe(1));
    expect(internal.getHookSteeringMessages()).toBeNull();
  });

  it("never runs the judge when the deterministic breaker fires instead", () => {
    const judge = vi.fn(async () => '{"loop": true}');
    const internal = makeSession(judge);
    // Three identical no-progress calls trip the deterministic breaker.
    internal.loopMonitor.stats = { toolFailures: 5, turns: 10, toolCalls: 6 };
    internal.loopMonitor.consecutiveFailures = 3;
    internal.loopMonitor.repeatedNoProgressCalls = 3;
    const messages = internal.getHookSteeringMessages();
    expect(judge).not.toHaveBeenCalled();
    expect(internal.loopMonitor.semanticLoop.checksUsed).toBe(0);
    expect(String(messages?.[0]?.content)).toContain("Stuck?");
  });

  it("respects the per-run budget across separate bursts", async () => {
    const judge = vi.fn(async () => '{"loop": false}');
    const internal = makeSession(judge);
    primeSuspicion(internal);
    internal.getHookSteeringMessages();
    await vi.waitFor(() => expect(internal.loopMonitor.semanticLoop.checksUsed).toBe(1));

    // A fresh burst past the cooldown: second and final check.
    internal.loopMonitor.stats.turns = 20;
    internal.loopMonitor.consecutiveFailures = 2;
    internal.getHookSteeringMessages();
    await vi.waitFor(() => expect(internal.loopMonitor.semanticLoop.checksUsed).toBe(2));

    // Third burst: budget spent, judge never consulted again.
    internal.loopMonitor.stats.turns = 40;
    internal.loopMonitor.consecutiveFailures = 2;
    expect(internal.getHookSteeringMessages()).toBeNull();
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it("discards a pending semantic verdict when the deterministic breaker fires first", () => {
    const internal = makeSession(async () => '{"loop": true, "reason": "r", "advice": "a"}');
    primeSuspicion(internal);
    internal.loopMonitor.semanticLoop.verdict = { loop: true, reason: "stale burst", advice: "" };
    // Deterministic signals now fire for the same burst.
    internal.loopMonitor.repeatedNoProgressCalls = 3;
    const messages = internal.getHookSteeringMessages();
    expect(String(messages?.[0]?.content)).toContain("Stuck?");
    // The semantic verdict for the SAME burst is gone — no double correction.
    expect(internal.loopMonitor.semanticLoop.verdict).toBeNull();
    expect(internal.getHookSteeringMessages()).toBeNull();
  });

  it("caps stored digests so huge tool payloads cannot inflate the ring", async () => {
    const internal = makeSession(async () => '{"loop": false}');
    const huge = "x".repeat(80_000);
    await internal.trackHookEvent({
      type: "tool_call_start",
      toolCallId: "c1",
      name: "write",
      args: { file_path: "src/big.ts", content: huge },
    });
    await internal.trackHookEvent({
      type: "tool_call_end",
      toolCallId: "c1",
      isError: false,
      result: huge,
      durationMs: 5,
    });
    expect(internal.loopMonitor.recentCalls.length).toBe(1);
    expect(internal.loopMonitor.recentCalls[0]?.args.length).toBeLessThanOrEqual(300);
    expect(internal.loopMonitor.recentCalls[0]?.result.length).toBeLessThanOrEqual(400);
  });
});
