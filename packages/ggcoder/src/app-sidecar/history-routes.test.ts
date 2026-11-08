import { describe, expect, it } from "vitest";
import { restoredWorkerRows } from "./history-routes.js";

const spawn = {
  name: "spawn_agent",
  args: {
    tasks: [
      { agent: "builder", task_name: "heat-pumps", prompt: "a" },
      { agent: "builder", task_name: "ev-batteries", prompt: "b" },
    ],
  },
};

describe("restoredWorkerRows", () => {
  it("shows one row per worker a spawn started", () => {
    expect(restoredWorkerRows(spawn, false).map((row) => row.agentName)).toEqual([
      "heat-pumps",
      "ev-batteries",
    ]);
  });

  it("shows no workers for a refused spawn, which started none", () => {
    // Live bug: a spawn blocked during a goal's briefing came back after a
    // restart as "critters didn't make it back".
    expect(restoredWorkerRows(spawn, true)).toEqual([]);
  });

  it("keeps a failed synchronous subagent, which did run", () => {
    expect(restoredWorkerRows({ name: "subagent", args: { agent: "scout" } }, true)).toEqual([
      { agentName: "scout", status: "error", toolUseCount: 0 },
    ]);
  });
});
