import { describe, expect, test } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import {
  buildHostCompletionGateFollowUp,
  buildProcessCompletionFollowUp,
  buildProcessCompletionGateMessage,
  isUnresolvedProcess,
  mergeCompletionGateFollowUps,
  MAX_PROCESS_GATE_INJECTIONS,
  selectUnresolvedProcesses,
  type GateableProcess,
} from "./process-gate.js";

const RUN_START = 1_000;

function proc(overrides: Partial<GateableProcess> = {}): GateableProcess {
  return {
    id: "aaaa1111",
    command: "pnpm test",
    startedAt: RUN_START + 10,
    exitCode: null,
    lastReadOffset: 0,
    logSize: 0,
    ...overrides,
  };
}

describe("isUnresolvedProcess", () => {
  test("gates a running process from this run whose output was never read", () => {
    expect(isUnresolvedProcess(proc(), RUN_START)).toBe(true);
  });

  test("exempts a process started before the run (long-lived dev server)", () => {
    expect(isUnresolvedProcess(proc({ startedAt: RUN_START - 1 }), RUN_START)).toBe(false);
  });

  test("exempts a running process whose output was already read", () => {
    expect(isUnresolvedProcess(proc({ lastReadOffset: 42, logSize: 42 }), RUN_START)).toBe(false);
  });

  test("exempts a clean exit", () => {
    expect(isUnresolvedProcess(proc({ exitCode: 0, logSize: 900 }), RUN_START)).toBe(false);
  });

  test("gates a non-zero exit with unread bytes", () => {
    expect(
      isUnresolvedProcess(proc({ exitCode: 1, logSize: 900, lastReadOffset: 100 }), RUN_START),
    ).toBe(true);
  });

  test("exempts a non-zero exit whose log was fully read", () => {
    expect(
      isUnresolvedProcess(proc({ exitCode: 1, logSize: 900, lastReadOffset: 900 }), RUN_START),
    ).toBe(false);
  });

  test("treats a process started exactly at run start as in-run", () => {
    expect(isUnresolvedProcess(proc({ startedAt: RUN_START }), RUN_START)).toBe(true);
  });
});

describe("selectUnresolvedProcesses", () => {
  test("orders by start time then id", () => {
    const selected = selectUnresolvedProcesses(
      [
        proc({ id: "cccc", startedAt: RUN_START + 30 }),
        proc({ id: "bbbb", startedAt: RUN_START + 10 }),
        proc({ id: "aaaa", startedAt: RUN_START + 10 }),
        proc({ id: "dddd", startedAt: RUN_START - 5 }),
      ],
      RUN_START,
    );
    expect(selected.map((p) => p.id)).toEqual(["aaaa", "bbbb", "cccc"]);
  });
});

describe("buildProcessCompletionGateMessage", () => {
  test("returns undefined when nothing is unresolved", () => {
    expect(buildProcessCompletionGateMessage([], RUN_START)).toBeUndefined();
    expect(
      buildProcessCompletionGateMessage([proc({ exitCode: 0, logSize: 10 })], RUN_START),
    ).toBeUndefined();
  });

  test("names running and failed processes separately and instructs task_output", () => {
    const message = buildProcessCompletionGateMessage(
      [
        proc({ id: "run1", command: "pnpm dev" }),
        proc({ id: "fail1", command: "pnpm build", exitCode: 2, logSize: 500 }),
      ],
      RUN_START,
    );
    expect(message).toContain("run1 (pnpm dev)");
    expect(message).toContain("fail1 (pnpm build)");
    expect(message).toContain("exited with code 2");
    expect(message).toContain("task_output");
    expect(message).toContain("task_stop");
  });

  test("omits the failed section when everything is still running", () => {
    const message = buildProcessCompletionGateMessage([proc()], RUN_START)!;
    expect(message).toContain("Still running");
    expect(message).not.toContain("Exited non-zero");
  });
});

describe("buildProcessCompletionFollowUp", () => {
  test("wraps the gate text in a user message", () => {
    const followUp = buildProcessCompletionFollowUp([proc()], RUN_START, 0);
    expect(followUp).toHaveLength(1);
    expect(followUp?.[0]?.role).toBe("user");
    expect(followUp?.[0]?.content).toContain("aaaa1111");
  });

  test("returns null once the per-run injection cap is reached", () => {
    expect(
      buildProcessCompletionFollowUp([proc()], RUN_START, MAX_PROCESS_GATE_INJECTIONS - 1),
    ).not.toBeNull();
    expect(
      buildProcessCompletionFollowUp([proc()], RUN_START, MAX_PROCESS_GATE_INJECTIONS),
    ).toBeNull();
    expect(
      buildProcessCompletionFollowUp([proc()], RUN_START, MAX_PROCESS_GATE_INJECTIONS + 1),
    ).toBeNull();
  });

  test("returns null when no process blocks completion", () => {
    expect(buildProcessCompletionFollowUp([], RUN_START, 0)).toBeNull();
  });
});

describe("terminal UI completion gates (buildHostCompletionGateFollowUp)", () => {
  const child: Message[] = [{ role: "user", content: "Collect child agent c1 before finishing." }];

  test("child-agent and process gates arrive in one follow-up: one forced turn, not two", () => {
    const counter = { runStartedAt: 0, injected: 0 };
    let childPending = true;
    const p = proc();
    let forcedTurns = 0;
    for (let stop = 0; stop < 5; stop++) {
      const followUp = buildHostCompletionGateFollowUp(
        childPending ? child : null,
        [p],
        RUN_START,
        counter,
      );
      if (!followUp) break;
      forcedTurns += 1;
      const text = followUp.map((m) => String(m.content)).join("\n");
      // Simulated model does everything the follow-up asks in that one turn.
      if (text.includes("c1")) childPending = false;
      if (text.includes(p.id)) p.lastReadOffset = 1;
    }
    expect(forcedTurns).toBe(1);
    expect(counter.injected).toBe(1);
  });

  test("resets the per-run cap when a new run starts and keeps the cap within a run", () => {
    const counter = { runStartedAt: 0, injected: 0 };
    const procs = [proc()];
    for (let i = 0; i < MAX_PROCESS_GATE_INJECTIONS; i++) {
      expect(buildHostCompletionGateFollowUp(null, procs, RUN_START, counter)).not.toBeNull();
    }
    expect(buildHostCompletionGateFollowUp(null, procs, RUN_START, counter)).toBeNull();
    // The child gate still fires after the process cap is spent.
    expect(buildHostCompletionGateFollowUp(child, procs, RUN_START, counter)).toEqual(child);
    const next = [proc({ startedAt: RUN_START + 5_000 })];
    expect(buildHostCompletionGateFollowUp(null, next, RUN_START + 4_000, counter)).not.toBeNull();
    expect(counter).toEqual({ runStartedAt: RUN_START + 4_000, injected: 1 });
  });

  test("mergeCompletionGateFollowUps is null when no gate fired", () => {
    expect(mergeCompletionGateFollowUps(null, [], undefined)).toBeNull();
  });
});
