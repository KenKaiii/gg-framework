import { describe, expect, it } from "vitest";
import {
  MAX_RUNS,
  goalFinishOf,
  goalIsQuiet,
  openStretch,
  recordRun,
  type GoalRun,
} from "./goal-finish";
import type { WorkerAgent, WorkerGroup } from "./worker-status";

const run = (over: Partial<GoalRun> = {}): GoalRun => ({
  goalId: "g",
  startedAt: 1000,
  endedAt: 2000,
  fromItemId: 10,
  turns: 3,
  outputTokens: 400,
  outcome: "done",
  ...over,
});

const worker = (over: Partial<WorkerAgent> = {}): WorkerAgent => ({
  key: "g1:t1",
  agentName: "builder",
  label: "builder",
  status: "running",
  activity: undefined,
  tokens: null,
  durationMs: 0,
  toolUseCount: 1,
  ...over,
});

describe("goal finish", () => {
  it("scores the stretch since the last finish or cancel", () => {
    const runs = [
      run({ startedAt: 0, endedAt: 500, outcome: "cancelled" }),
      run({ startedAt: 1000, endedAt: 2000, fromItemId: 10 }),
      run({ startedAt: 5000, endedAt: 8000, fromItemId: 20, turns: 2, outputTokens: 100 }),
      run({ goalId: "other", endedAt: 9000 }),
    ];
    const stretch = openStretch(runs, "g", 0);
    expect(stretch.map((r) => r.endedAt)).toEqual([2000, 8000]);
    expect(openStretch(runs, "g", 2000).map((r) => r.endedAt)).toEqual([8000]);
    const groups: WorkerGroup[] = [
      { id: 5, agents: [{ toolCallId: "old", status: "done", activities: [], toolUseCount: 1 }] },
      {
        id: 12,
        agents: [
          {
            toolCallId: "a",
            status: "done",
            activities: [],
            toolUseCount: 4,
            tokenUsage: { input: 9, output: 1000 },
          },
          { toolCallId: "b", status: "error", activities: [], toolUseCount: 1 },
        ],
      },
    ];
    expect(goalFinishOf(stretch, groups)).toMatchObject({
      id: 8000,
      outcome: "done",
      elapsedMs: 7000,
      turns: 5,
      workers: 2,
      failedWorkers: 1,
      outputTokens: 1500,
    });
  });

  it("says plainly how a stretch ended, and has nothing to score without runs", () => {
    expect(goalFinishOf([run({ outcome: "failed" })], [])?.line).toContain("couldn't finish");
    expect(goalFinishOf([run({ outcome: "cancelled" })], [])).toBeNull();
    expect(goalFinishOf([], [])).toBeNull();
  });

  it("only counts as quiet with nothing running, asked, paused or at work", () => {
    const quiet = { paused: false, running: false, waitingOnUser: false, workers: [] };
    expect(goalIsQuiet(quiet)).toBe(true);
    expect(goalIsQuiet({ ...quiet, running: true })).toBe(false);
    expect(goalIsQuiet({ ...quiet, paused: true })).toBe(false);
    expect(goalIsQuiet({ ...quiet, waitingOnUser: true })).toBe(false);
    expect(goalIsQuiet({ ...quiet, workers: [worker()] })).toBe(false);
    expect(goalIsQuiet({ ...quiet, workers: [worker({ status: "idle" })] })).toBe(true);
  });

  it("keeps only the newest runs", () => {
    let runs: readonly GoalRun[] = [];
    for (let i = 0; i < MAX_RUNS + 5; i++) runs = recordRun(runs, run({ endedAt: i }));
    expect(runs).toHaveLength(MAX_RUNS);
    expect(runs[0]?.endedAt).toBe(5);
  });
});
