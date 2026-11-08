import { describe, expect, it } from "vitest";
import type { LiveToolEntry } from "../LiveToolPanel";
import type { SubAgentLine } from "../SubAgentFeed";
import {
  COORDINATOR_KEY,
  collectGoalAgents,
  collectWorkers,
  coordinatorKind,
  goalAgentStateLabel,
  toolKindOf,
  type ToolKind,
  type WorkerAgent,
} from "./worker-status";

const worker = (over: Partial<WorkerAgent> = {}): WorkerAgent => ({
  key: "g1:t1",
  agentName: "researcher",
  label: "Researcher",
  status: "running",
  activity: "Reading src/app.ts",
  tokens: "",
  durationMs: 0,
  toolUseCount: 1,
  ...over,
});

const tool = (over: Partial<LiveToolEntry>): LiveToolEntry => ({
  toolCallId: "a",
  name: "read",
  args: {},
  status: "done",
  ...over,
});

describe("goal agents", () => {
  it("puts the coordinator first and reads its work from the live tool feed", () => {
    const agents = collectGoalAgents({
      running: true,
      waitingOnUser: false,
      liveTools: [
        tool({ toolCallId: "a", name: "read", args: { file_path: "/x/a.ts" } }),
        tool({
          toolCallId: "b",
          name: "web_search",
          args: { query: "seo 2026" },
          status: "running",
        }),
      ],
      workers: [worker()],
    });
    expect(agents.map((a) => a.key)).toEqual([COORDINATOR_KEY, "g1:t1"]);
    expect(agents[0]).toMatchObject({
      name: "Kleio Goals",
      kind: "web",
      detail: "Browsing seo 2026",
    });
    expect(agents[1]).toMatchObject({ kind: "read", status: "working" });
  });

  it("shows the coordinator waiting on the user, and idle when not running", () => {
    const base = { liveTools: [], workers: [] };
    const waiting = collectGoalAgents({ ...base, running: true, waitingOnUser: true })[0];
    expect(waiting?.kind).toBe("ask");
    expect(waiting && goalAgentStateLabel(waiting)).toBe("Waiting for you");
    const idle = collectGoalAgents({ ...base, running: false, waitingOnUser: false })[0];
    expect(idle).toMatchObject({ status: "idle", kind: null });
    expect(idle && goalAgentStateLabel(idle)).toBe("Idle");
  });

  it("keeps the coordinator with its last work between tool calls", () => {
    const base = { running: true, waitingOnUser: false, workers: [] };
    expect(collectGoalAgents({ ...base, liveTools: [] })[0]).toMatchObject({
      kind: "think",
      detail: "Planning",
    });
    expect(collectGoalAgents({ ...base, liveTools: [tool({ name: "read" })] })[0]).toMatchObject({
      kind: "read",
      detail: "Planning",
    });
    // An answered question doesn't keep it waiting on the user.
    expect(collectGoalAgents({ ...base, liveTools: [tool({ name: "ask_user" })] })[0]?.kind).toBe(
      "think",
    );
  });

  it("maps orchestration tools to orchestration work", () => {
    expect(coordinatorKind("spawn_agent")).toBe("delegate");
    expect(coordinatorKind("wait_agent")).toBe("wait");
    expect(coordinatorKind("ask_user")).toBe("ask");
    expect(coordinatorKind("edit")).toBe("edit");
    expect(coordinatorKind("some_mcp_tool")).toBe("think");
  });

  it("marks finished and failed workers with nothing to do", () => {
    const agents = collectGoalAgents({
      running: false,
      waitingOnUser: false,
      liveTools: [],
      workers: [worker({ status: "done" }), worker({ key: "g1:t2", status: "error" })],
    });
    expect(
      agents.slice(1).map((a) => [a.status, a.kind, a.detail, goalAgentStateLabel(a)]),
    ).toEqual([
      ["done", null, "Finished", "Done"],
      ["error", null, "Stopped", "Stopped"],
    ]);
  });
});

describe("collectWorkers", () => {
  const line = (over: Partial<SubAgentLine> = {}): SubAgentLine => ({
    toolCallId: "t1",
    status: "running",
    activities: ["Reading a.ts", "Running pnpm test"],
    toolUseCount: 2,
    ...over,
  });

  it("flattens groups, keyed by group and call, with the latest activity", () => {
    const workers = collectWorkers([
      { id: 1, agents: [line({ agentName: "researcher" }), line({ toolCallId: "t2" })] },
      { id: 2, agents: [line({ status: "starting" })], aborted: true },
    ]);
    expect(workers.map((w) => [w.key, w.label, w.status, w.activity])).toEqual([
      ["1:t1", "researcher", "running", "Running pnpm test"],
      ["1:t2", "Agent 2", "running", "Running pnpm test"],
      ["2:t1", "Agent 1", "interrupted", "Running pnpm test"],
    ]);
  });
});

describe("toolKindOf", () => {
  const cases: readonly (readonly [string | undefined, ToolKind | null])[] = [
    // Humanized (formatToolActivity)
    ["Reading src/app.ts", "read"],
    ["Writing src/new.ts", "edit"],
    ["Editing src/app.ts", "edit"],
    ['Searching for "collectWorkers"', "search"],
    ['Finding "**/*.ts"', "search"],
    ["Listing src", "read"],
    ["Running pnpm test", "run"],
    ["Fetching https://example.com", "web"],
    ["Resolving source for zod", "search"],
    ["Reading task output abc123", null],
    ["Stopping task abc123", null],
    ["Searching web for vitest fake timers", "web"],
    ["Loading skill release", "read"],
    ["mcp__thing: detail", null],
    ["custom_tool", null],
    // Raw (subagent-manager activity())
    ["read: /a/b.ts", "read"],
    ["ls: /a", "read"],
    ["bash: pnpm test", "run"],
    ["grep: foo", "search"],
    ["find: **/*.md", "search"],
    ["edit: /a/b.ts", "edit"],
    ["write: /a/b.ts", "edit"],
    ["web_fetch: https://example.com", "web"],
    ["web_search: query", "web"],
    ["task_output: abc", null],
    ["bash", "run"],
    ["read", "read"],
    ["unknown_tool: x", null],
    // Removed tools are no longer known (21adf945)
    ["code_search: foo", null],
    ["code_nav: foo", null],
    // Edge cases
    [undefined, null],
    ["", null],
    ["   ", null],
    ["Readingish", null],
    ["toString", null],
  ];

  it.each(cases)("%j → %j", (activity, kind) => {
    expect(toolKindOf(activity)).toBe(kind);
  });
});
