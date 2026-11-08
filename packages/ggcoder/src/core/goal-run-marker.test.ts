import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GOAL_RUN_STALE_MS,
  goalRunLive,
  goalRunMarkerLive,
  goalRunMarkerPath,
  goalRunningElsewhere,
  holdGoalRun,
  readGoalRunMarker,
  type GoalRunMarker,
} from "./goal-run-marker.js";
import { createGoal, goalsRoot, markGoalStarted } from "./goals-store.js";
import { summarizeGoal } from "./goal-summary.js";
import { SessionManager } from "./session-manager.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-goal-run-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A marker as another process would leave it. */
async function writeForeign(dir: string, marker: Partial<GoalRunMarker>): Promise<void> {
  const at = new Date().toISOString();
  await fs.mkdir(path.dirname(goalRunMarkerPath(dir)), { recursive: true });
  await fs.writeFile(
    goalRunMarkerPath(dir),
    JSON.stringify({
      version: 1,
      // The test runner's parent: alive for the whole run, and not this process.
      pid: process.ppid,
      token: "other",
      startedAt: at,
      heartbeatAt: at,
      ...marker,
    }),
  );
}

describe("goal run marker", () => {
  it("counts a run only while its process is alive and its heartbeat is fresh", () => {
    const now = Date.parse("2026-10-14T12:00:00.000Z");
    const marker: GoalRunMarker = {
      version: 1,
      pid: 4242,
      token: "t",
      startedAt: "2026-10-14T11:00:00.000Z",
      heartbeatAt: new Date(now - 5_000).toISOString(),
    };
    expect(goalRunMarkerLive(marker, now, () => true)).toBe(true);
    // A crash: the file stays, the process doesn't.
    expect(goalRunMarkerLive(marker, now, () => false)).toBe(false);
    // A recycled pid can't revive a run whose heartbeat stopped.
    const stale = { ...marker, heartbeatAt: new Date(now - GOAL_RUN_STALE_MS - 1).toISOString() };
    expect(goalRunMarkerLive(stale, now, () => true)).toBe(false);
    expect(goalRunMarkerLive({ ...marker, heartbeatAt: "nonsense" }, now, () => true)).toBe(false);
  });

  it("holds while this process works, nests, and clears when the last hold lets go", () => {
    expect(goalRunLive(tmp)).toBe(false);
    const first = holdGoalRun(tmp);
    const second = holdGoalRun(tmp);
    const marker = readGoalRunMarker(tmp);
    expect(marker?.pid).toBe(process.pid);
    expect(goalRunLive(tmp)).toBe(true);
    // Its own run is not "elsewhere": that must not block its own resume.
    expect(goalRunningElsewhere(tmp)).toBe(false);
    first();
    first();
    expect(goalRunLive(tmp)).toBe(true);
    second();
    expect(readGoalRunMarker(tmp)).toBeNull();
  });

  it("sees a run in another process, and never deletes that process's marker", async () => {
    await writeForeign(tmp, {});
    expect(goalRunLive(tmp)).toBe(true);
    expect(goalRunningElsewhere(tmp)).toBe(true);

    // This process starts and stops while the other one has taken the file over.
    const release = holdGoalRun(tmp);
    await writeForeign(tmp, {});
    release();
    expect(readGoalRunMarker(tmp)?.token).toBe("other");
  });

  it("ignores a marker it can't read", async () => {
    await fs.mkdir(path.dirname(goalRunMarkerPath(tmp)), { recursive: true });
    await fs.writeFile(goalRunMarkerPath(tmp), "{ not json");
    expect(readGoalRunMarker(tmp)).toBeNull();
    await writeForeign(tmp, { pid: -1 });
    expect(readGoalRunMarker(tmp)).toBeNull();
    expect(goalRunLive(tmp)).toBe(false);
  });
});

describe("goal list status across processes", () => {
  it("shows a goal another process is running as running, not interrupted", async () => {
    const created = await createGoal(goalsRoot(tmp), { name: "Pew2", goal: "Ship it" }, new Date());
    if (!created.ok) throw new Error(created.error);
    const { dir } = created.value;
    const record = (await markGoalStarted(dir, new Date()))!;

    // Kleio Goals' last message so far is a tool call: mid-turn, as it is while
    // the phone's `kleio-coder acp` is running it.
    const sessions = new SessionManager(path.join(tmp, "sessions"));
    const session = await sessions.create(dir, "anthropic", "test-model");
    await sessions.appendEntry(session.path, {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "bash", args: { command: "ls" } }],
      },
    });

    // Nobody holds it: cut off mid-work, as before.
    expect((await summarizeGoal(sessions, dir, record)).status).toBe("interrupted");

    // Another process is working on it.
    await writeForeign(dir, {});
    expect((await summarizeGoal(sessions, dir, record)).status).toBe("running");

    // That process crashed: its heartbeat went stale.
    await writeForeign(dir, {
      heartbeatAt: new Date(Date.now() - GOAL_RUN_STALE_MS - 1_000).toISOString(),
    });
    expect((await summarizeGoal(sessions, dir, record)).status).toBe("interrupted");
  });
});
