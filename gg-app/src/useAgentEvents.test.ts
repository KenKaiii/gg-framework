// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createRef } from "react";
import type { MutableRefObject } from "react";

// playSound builds an <audio> element and ./agent calls Tauri APIs at module
// scope (getCurrentWebviewWindow) which blow up in jsdom. Fully stub both. The
// hook only uses `listCommands` from ./agent at runtime (the rest is type-only,
// erased), so the mock just provides that, resolving empty so run_end's command
// refresh is a no-op.
vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("./agent", () => ({ listCommands: vi.fn().mockResolvedValue([]) }));

import { useAgentEvents, type AgentEventsDeps } from "./useAgentEvents";
import type { Item } from "./App";
import type { AgentState, SidecarEvent } from "./agent";
import type { LiveToolEntry } from "./LiveToolPanel";

const ev = (type: string, data: Record<string, unknown> = {}): SidecarEvent =>
  ({ type, data }) as SidecarEvent;

function setup(
  handleKenEvent: (e: SidecarEvent) => boolean = () => false,
  initialState: Partial<AgentState> = {},
) {
  let items: Item[] = [];
  let id = 0;
  const setItems = (u: Item[] | ((prev: Item[]) => Item[])): void => {
    items = typeof u === "function" ? u(items) : u;
  };
  const nextId = (): number => ++id;

  // Track the outputs the assertions read; spy the rest so nothing throws.
  let liveToolFeed: LiveToolEntry[] = [];
  let planReview: string | null = null;
  const setLiveToolFeed = vi.fn(
    (u: LiveToolEntry[] | ((p: LiveToolEntry[]) => LiveToolEntry[])) => {
      liveToolFeed = typeof u === "function" ? u(liveToolFeed) : u;
    },
  ) as unknown as AgentEventsDeps["setLiveToolFeed"];
  const setRunning = vi.fn() as unknown as AgentEventsDeps["setRunning"];
  const setTokens = vi.fn() as unknown as AgentEventsDeps["setTokens"];

  // Real reducer-style state holder so functional setState updates (used by
  // model_change / ken_model_change spreads) apply against a base state.
  let agentState: AgentState | null = {
    provider: "anthropic",
    model: "claude-opus-5",
    cwd: "/tmp/proj",
    running: false,
    ...initialState,
  } as AgentState;
  const stateRef = createRef() as MutableRefObject<AgentEventsDeps["stateRef"]["current"]>;
  const setState = ((u: AgentState | null | ((p: AgentState | null) => AgentState | null)) => {
    agentState = typeof u === "function" ? u(agentState) : u;
    stateRef.current = agentState;
  }) as AgentEventsDeps["setState"];

  const noop = (): void => {};
  stateRef.current = agentState;
  const deps: AgentEventsDeps = {
    setItems: setItems as AgentEventsDeps["setItems"],
    nextId,
    handleKenEvent,
    handleAutopilotEvent: () => false,
    setState,
    setTasks: noop as unknown as AgentEventsDeps["setTasks"],
    setProjectTasks: noop as unknown as AgentEventsDeps["setProjectTasks"],
    setStatus: noop as unknown as AgentEventsDeps["setStatus"],
    setRunning,
    setLiveToolFeed,
    setTokens,
    setContextTokens: noop as unknown as AgentEventsDeps["setContextTokens"],
    setDoneStatus: noop as unknown as AgentEventsDeps["setDoneStatus"],
    setIsThinking: noop as unknown as AgentEventsDeps["setIsThinking"],
    setThinkingStartTs: noop as unknown as AgentEventsDeps["setThinkingStartTs"],
    setThinkingAccumMs: noop as unknown as AgentEventsDeps["setThinkingAccumMs"],
    setPlanTotal: noop as unknown as AgentEventsDeps["setPlanTotal"],
    setPlanDone: noop as unknown as AgentEventsDeps["setPlanDone"],
    setSessionTitle: noop as unknown as AgentEventsDeps["setSessionTitle"],
    setPlanReview: ((u: string | null | ((p: string | null) => string | null)) => {
      planReview = typeof u === "function" ? u(planReview) : u;
    }) as AgentEventsDeps["setPlanReview"],
    setQueuedCount: noop as unknown as AgentEventsDeps["setQueuedCount"],
    setAttachments: noop as unknown as AgentEventsDeps["setAttachments"],
    setCommands: noop as unknown as AgentEventsDeps["setCommands"],
    stateRef,
    planDoneRef: { current: new Set<number>() },
    planTotalRef: { current: 0 },
    planReviewPathRef: { current: null },
    pendingPlanTotalRef: { current: null },
    stickToBottomRef: { current: true },
  };

  const hook = renderHook(() => useAgentEvents(deps));
  return {
    hook,
    deps,
    getItems: () => items,
    getLiveToolFeed: () => liveToolFeed,
    getPlanReview: () => planReview,
    getState: () => agentState,
    setRunning,
    setTokens,
  };
}

describe("useAgentEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the run owned while cancellation is pending", () => {
    const { hook, getState, setRunning } = setup(() => false, {
      running: true,
      runState: "running",
    });
    act(() => hook.result.current.handleEvent(ev("run_cancelling", { runState: "cancelling" })));
    expect(getState()).toMatchObject({ running: true, runState: "cancelling" });
    expect(setRunning).toHaveBeenLastCalledWith(true);
  });

  it("restores the running affordance after cancellation failure", () => {
    const { hook, getState, setRunning } = setup(() => false, {
      running: true,
      runState: "cancelling",
    });
    act(() => hook.result.current.handleEvent(ev("cancel_failed", { runState: "running" })));
    expect(getState()).toMatchObject({ running: true, runState: "running" });
    expect(setRunning).toHaveBeenLastCalledWith(true);
  });

  it("becomes idle only when the owning run emits run_end", () => {
    const { hook, getState, setRunning } = setup(() => false, {
      running: true,
      runState: "cancelling",
    });
    act(() => hook.result.current.handleEvent(ev("run_end", { cancelled: true })));
    expect(getState()).toMatchObject({ running: false, runState: "idle" });
    expect(setRunning).toHaveBeenLastCalledWith(false);
  });

  it("text_delta streams assistant text into a single item", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: "Hello" }));
    });
    let items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "Hello" });

    // First-token path creates the bubble synchronously; a second delta buffers
    // via the 100ms flush timer, so flush it by ending the stream
    // (endStreamingText drains the buffer).
    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: " world" }));
      hook.result.current.endStreamingText();
    });
    items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "Hello world" });
  });

  it("error with a structured payload (headline/message/guidance) pushes a structured error item", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("error", {
          headline: "Anthropic usage limit reached.",
          message: "Your Anthropic usage is finished. It resets at 12:50 PM.",
          guidance: "Try again once it's back. Your conversation is preserved.",
        }),
      );
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "error",
      headline: "Anthropic usage limit reached.",
      message: "Your Anthropic usage is finished. It resets at 12:50 PM.",
      guidance: "Try again once it's back. Your conversation is preserved.",
    });
  });

  it("error with only a message (legacy shape) falls back to a flat text item", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("error", { message: "boom" }));
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "error" });
    expect((items[0] as { text: string }).text).toContain("boom");
  });

  it("tool_call_start then tool_call_end drive the live tool feed", () => {
    const { hook, getLiveToolFeed } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("tool_call_start", { toolCallId: "t1", name: "read", args: { file_path: "a.ts" } }),
      );
    });
    let feed = getLiveToolFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ toolCallId: "t1", status: "running" });

    act(() => {
      hook.result.current.handleEvent(ev("tool_call_end", { toolCallId: "t1", isError: false }));
    });
    feed = getLiveToolFeed();
    expect(feed[0]).toMatchObject({ toolCallId: "t1", status: "done" });
  });

  it("turn_end accumulates output tokens across turns", () => {
    const { hook, setTokens } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("turn_end", { usage: { outputTokens: 10 } }));
    });
    expect(setTokens).toHaveBeenLastCalledWith(10);
    act(() => {
      hook.result.current.handleEvent(ev("turn_end", { usage: { outputTokens: 5 } }));
    });
    // Accumulates (tokensRef is internal): 10 + 5 = 15.
    expect(setTokens).toHaveBeenLastCalledWith(15);
  });

  it("updates the active chat agent after a handoff", () => {
    const { hook, getState } = setup(() => false, { chatAgent: "general" });
    act(() => {
      hook.result.current.handleEvent(ev("chat_agent_change", { chatAgent: "therapist" }));
    });
    expect(getState()).toMatchObject({ chatAgent: "therapist" });
  });
  it("delegates ken_ events to handleKenEvent and does not handle them locally", () => {
    const handleKenEvent = vi.fn(() => true);
    const { hook, getItems, setRunning } = setup(handleKenEvent);
    act(() => {
      hook.result.current.handleEvent(ev("ken_text_delta", { text: "from ken" }));
      hook.result.current.handleEvent(ev("ken_run_start"));
    });
    expect(handleKenEvent).toHaveBeenCalledTimes(2);
    // Nothing handled locally: no assistant item, run state untouched.
    expect(getItems()).toHaveLength(0);
    expect(setRunning).not.toHaveBeenCalled();
  });

  it("ken_model_change updates Ken's footer model state (falls through ken_ delegation)", () => {
    // useKenMentor's handleKenEvent returns false for ken_model_change (it only
    // owns the chat-bubble events), so the event must reach the main switch —
    // the default setup handleKenEvent mirrors that by returning false.
    const { hook, getState } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("ken_model_change", {
          kenProvider: "openai",
          kenModel: "gpt-5.5",
          kenModelOverride: true,
        }),
      );
    });
    expect(getState()).toMatchObject({
      kenProvider: "openai",
      kenModel: "gpt-5.5",
      kenModelOverride: true,
      // GG Coder's own model is untouched by a Ken pin.
      model: "claude-opus-5",
      provider: "anthropic",
    });

    // Clearing the pin: sidecar broadcasts Ken back on GG Coder's model.
    act(() => {
      hook.result.current.handleEvent(
        ev("ken_model_change", {
          kenProvider: "anthropic",
          kenModel: "claude-opus-5",
          kenModelOverride: false,
        }),
      );
    });
    expect(getState()).toMatchObject({ kenModel: "claude-opus-5", kenModelOverride: false });
  });

  it("plan_exit opens the human review modal when autopilot is off", () => {
    const { hook, getPlanReview } = setup(() => false, { autopilot: false });
    act(() => {
      hook.result.current.handleEvent(
        ev("plan_exit", { planPath: "/tmp/p.md", content: "# Plan" }),
      );
    });
    expect(getPlanReview()).toBe("# Plan");
  });

  it("plan_exit hides the human review modal when autopilot is on", () => {
    const { hook, getPlanReview, deps } = setup(() => false, { autopilot: true });
    act(() => {
      hook.result.current.handleEvent(
        ev("plan_exit", { planPath: "/tmp/p.md", content: "# Plan" }),
      );
    });
    // The content/path are still stashed for Ken auto-review + auto-accept step
    // counting, but the human overlay stays hidden while autopilot owns review.
    expect(getPlanReview()).toBeNull();
    expect(deps.planReviewPathRef.current).toBe("/tmp/p.md");
  });

  it("autopilot_plan_accepted seeds the plan step count and pushes the marker", () => {
    const { hook, deps, getItems } = setup();
    const plan =
      "# Plan\n\n## Steps\n\n1. Add the provider config module\n2. Wire the callback route";
    act(() => {
      // plan_exit stashes the plan content the accepted-frame reads.
      hook.result.current.handleEvent(ev("plan_exit", { planPath: "/tmp/p.md", content: plan }));
      hook.result.current.handleEvent(ev("autopilot_plan_accepted", {}));
    });
    // Step count seeded for the accept-driven session_reset to carry over.
    expect(deps.pendingPlanTotalRef.current).toBe(2);
    // The approved marker lands in the transcript (rendered as a Ken bubble).
    const marker = getItems().find((i) => i.kind === "autopilot");
    expect(marker).toMatchObject({ kind: "autopilot", phase: "plan_approved" });
  });

  it("autopilot_prompted closes the stale plan modal after Ken asks for revision", () => {
    const { hook, getPlanReview } = setup();
    act(() => {
      hook.result.current.handleEvent(
        ev("plan_exit", { planPath: "/tmp/p.md", content: "# Plan" }),
      );
    });
    expect(getPlanReview()).toBe("# Plan");
    act(() => {
      hook.result.current.handleEvent(ev("autopilot_prompted", { round: 1, body: "revise it" }));
    });
    // Autopilot-only: a revision prompt means Ken took over the plan review;
    // the human modal should disappear. Non-autopilot never emits this frame.
    expect(getPlanReview()).toBeNull();
  });

  it("run_end clears running state", () => {
    const { hook, setRunning } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("run_start"));
    });
    expect(setRunning).toHaveBeenLastCalledWith(true);
    act(() => {
      hook.result.current.handleEvent(ev("run_end", { cancelled: false }));
    });
    expect(setRunning).toHaveBeenLastCalledWith(false);
  });

  it("upserts persistent async agents by agent_id through idle and interrupted states", () => {
    const { hook, getItems } = setup();
    const base = {
      agent_id: "abcd1234",
      task_name: "scan auth",
      started_at: 1,
      updated_at: 2,
      elapsed_ms: 10,
      turn_count: 0,
      tool_use_count: 0,
      token_usage: { input: 0, output: 0 },
    };
    act(() =>
      hook.result.current.handleEvent(ev("subagent_state", { ...base, state: "starting" })),
    );
    act(() =>
      hook.result.current.handleEvent(
        ev("subagent_state", {
          ...base,
          state: "completed",
          elapsed_ms: 30,
          tool_use_count: 2,
          token_usage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 5 },
        }),
      ),
    );
    const groups = getItems().filter((item) => item.kind === "subagent_group");
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.kind === "subagent_group" ? group.agents : []).toMatchObject([
      {
        toolCallId: "abcd1234",
        status: "idle",
        async: true,
        toolUseCount: 2,
        tokenUsage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 5 },
      },
    ]);
  });

  it("keeps late async snapshots attached to their original run group", () => {
    const { hook, getItems } = setup();
    const snapshot = (agentId: string, state: "starting" | "completed") => ({
      agent_id: agentId,
      task_name: agentId,
      state,
      started_at: 1,
      updated_at: 2,
      elapsed_ms: 10,
      turn_count: 0,
      tool_use_count: 0,
      token_usage: { input: 0, output: 0 },
    });

    act(() => {
      hook.result.current.handleEvent(ev("run_start"));
      hook.result.current.handleEvent(ev("subagent_state", snapshot("old-agent", "starting")));
      hook.result.current.handleEvent(ev("run_end", { cancelled: false }));
      hook.result.current.handleEvent(ev("run_start"));
      hook.result.current.handleEvent(ev("subagent_state", snapshot("new-agent", "starting")));
      hook.result.current.handleEvent(ev("subagent_state", snapshot("old-agent", "completed")));
    });

    const groups = getItems().filter((item) => item.kind === "subagent_group");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.kind === "subagent_group" ? groups[0].agents : []).toMatchObject([
      { toolCallId: "old-agent", status: "idle" },
    ]);
    expect(groups[1]?.kind === "subagent_group" ? groups[1].agents : []).toMatchObject([
      { toolCallId: "new-agent", status: "starting" },
    ]);
  });
});
