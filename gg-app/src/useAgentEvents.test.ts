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
vi.mock("./agent", () => ({
  listCommands: vi.fn().mockResolvedValue([]),
  listModels: vi.fn().mockResolvedValue([]),
}));

import { listModels } from "./agent";
import { useAgentEvents, type AgentEventsDeps } from "./useAgentEvents";
import type { Item } from "./App";
import type { AgentState, SidecarEvent } from "./agent";
import type { LiveToolEntry } from "./LiveToolPanel";

const ev = (type: string, data: Record<string, unknown> = {}): SidecarEvent =>
  ({ type, data }) as SidecarEvent;

// subagent_state snapshots are buffered and flushed on a 150ms timer (burst
// coalescing). Tests that assert on subagent groups let the flush fire first.
const flushSubagents = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
};

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

  let models: unknown[] = [];
  const setModels = ((u: unknown) => {
    models =
      typeof u === "function" ? (u as (p: unknown[]) => unknown[])(models) : (u as unknown[]);
  }) as unknown as AgentEventsDeps["setModels"];

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
    setDoneStatus: vi.fn<AgentEventsDeps["setDoneStatus"]>(),
    setIsThinking: noop as unknown as AgentEventsDeps["setIsThinking"],
    setThinkingStartTs: noop as unknown as AgentEventsDeps["setThinkingStartTs"],
    setThinkingAccumMs: noop as unknown as AgentEventsDeps["setThinkingAccumMs"],
    setPlanTotal: noop as unknown as AgentEventsDeps["setPlanTotal"],
    setPlanDone: noop as unknown as AgentEventsDeps["setPlanDone"],
    setPlanReview: ((u: string | null | ((p: string | null) => string | null)) => {
      planReview = typeof u === "function" ? u(planReview) : u;
    }) as AgentEventsDeps["setPlanReview"],
    setQueuedCount: noop as unknown as AgentEventsDeps["setQueuedCount"],
    setQueuedMessages: noop as unknown as AgentEventsDeps["setQueuedMessages"],
    setAttachments: noop as unknown as AgentEventsDeps["setAttachments"],
    setCommands: noop as unknown as AgentEventsDeps["setCommands"],
    setModels,
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
    pushUserItem: (text: string, queued: boolean): void => {
      setItems((prev) => [...prev, { kind: "user", id: nextId(), text, queued } as Item]);
    },
    getLiveToolFeed: () => liveToolFeed,
    getPlanReview: () => planReview,
    getState: () => agentState,
    getModels: () => models,
    setRunning,
    setTokens,
  };
}

describe("useAgentEvents", () => {
  it("shows Unverified instead of completion and does not finish an approved plan", () => {
    const { hook, deps } = setup();
    act(() => hook.result.current.handleEvent(ev("run_start", {})));
    deps.planTotalRef.current = 2;
    deps.planDoneRef.current = new Set([1, 2]);
    act(() => hook.result.current.handleEvent(ev("run_end", { unverified: true })));
    expect(deps.setDoneStatus).toHaveBeenLastCalledWith(expect.stringMatching(/^Unverified /));
    expect(deps.planTotalRef.current).toBe(2);
    expect(deps.planDoneRef.current).toEqual(new Set([1, 2]));
  });

  beforeEach(() => vi.clearAllMocks());

  describe("queued pill lifecycle", () => {
    it("clears a bubble's queued pill as soon as the agent consumes it, mid-run", () => {
      const { hook, getItems, pushUserItem, setRunning } = setup();
      act(() => setRunning(true));
      pushUserItem("first queued", true);
      pushUserItem("second queued", true);

      // The sidecar acknowledges both enqueues.
      act(() => {
        hook.result.current.handleEvent(
          ev("queued", {
            count: 2,
            messages: [
              { id: "a", text: "first queued" },
              { id: "b", text: "second queued" },
            ],
          }),
        );
      });
      // The agent drains ONE message at the turn boundary: the sidecar
      // re-broadcasts queue_drained as `queued` with the remaining list.
      act(() => {
        hook.result.current.handleEvent(
          ev("queued", { count: 1, messages: [{ id: "b", text: "second queued" }] }),
        );
      });

      const users = getItems().filter((it) => it.kind === "user");
      expect(users[0]?.queued).toBe(false);
      // Marked for the queued→sent morph, so the bubble animates out of the dim
      // dashed look instead of snapping.
      expect(users[0]?.promoted).toBe(true);
      // The still-pending one keeps its pill.
      expect(users[1]?.queued).toBe(true);
      expect(users[1]?.promoted).toBeUndefined();
    });

    it("drops the morph flag once the animation beat is over", async () => {
      const { hook, getItems, pushUserItem, setRunning } = setup();
      act(() => setRunning(true));
      pushUserItem("only queued", true);

      act(() => {
        hook.result.current.handleEvent(
          ev("queued", { count: 1, messages: [{ id: "a", text: "only queued" }] }),
        );
      });
      act(() => {
        hook.result.current.handleEvent(ev("queued", { count: 0, messages: [] }));
      });
      expect(getItems().find((it) => it.kind === "user")?.promoted).toBe(true);

      // Left set, the flag would replay the collapse whenever the transcript
      // remounts (a picker view taking the window and coming back).
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      expect(getItems().find((it) => it.kind === "user")?.promoted).toBe(false);
    });

    it("clears the rest once the queue fully drains, still mid-run", () => {
      const { hook, getItems, pushUserItem, setRunning } = setup();
      act(() => setRunning(true));
      pushUserItem("first queued", true);
      pushUserItem("second queued", true);

      act(() => {
        hook.result.current.handleEvent(
          ev("queued", {
            count: 2,
            messages: [
              { id: "a", text: "first queued" },
              { id: "b", text: "second queued" },
            ],
          }),
        );
      });
      act(() => {
        hook.result.current.handleEvent(
          ev("queued", { count: 1, messages: [{ id: "b", text: "second queued" }] }),
        );
      });
      act(() => {
        hook.result.current.handleEvent(ev("queued", { count: 0, messages: [] }));
      });

      expect(
        getItems()
          .filter((it) => it.kind === "user")
          .every((it) => it.queued === false),
      ).toBe(true);
    });

    it("keeps the pill while the message is still pending", () => {
      const { hook, getItems, pushUserItem, setRunning } = setup();
      act(() => setRunning(true));
      pushUserItem("still waiting", true);

      // A fresh enqueue (depth grew) must not clear anything.
      act(() => {
        hook.result.current.handleEvent(
          ev("queued", { count: 1, messages: [{ id: "a", text: "still waiting" }] }),
        );
      });

      expect(getItems().find((it) => it.kind === "user")?.queued).toBe(true);
    });

    it("clears exactly one of two identical queued messages", () => {
      // Set membership would leave BOTH lit here: the text is still present in
      // the pending list, so nothing would ever clear until the queue emptied.
      const { hook, getItems, pushUserItem, setRunning } = setup();
      act(() => setRunning(true));
      pushUserItem("same text", true);
      pushUserItem("same text", true);

      // Both acknowledged as queued.
      act(() => {
        hook.result.current.handleEvent(
          ev("queued", {
            count: 2,
            messages: [
              { id: "a", text: "same text" },
              { id: "b", text: "same text" },
            ],
          }),
        );
      });
      // One consumed.
      act(() => {
        hook.result.current.handleEvent(
          ev("queued", { count: 1, messages: [{ id: "b", text: "same text" }] }),
        );
      });

      const users = getItems().filter((it) => it.kind === "user");
      // FIFO: the older bubble is the one the agent took.
      expect(users[0]?.queued).toBe(false);
      expect(users[1]?.queued).toBe(true);
    });

    it("keeps the pill on a message the sidecar has not acknowledged yet", () => {
      // The bubble is marked queued optimistically. A queue snapshot that
      // predates the enqueue must not clear it, because nothing re-sets the flag.
      const { hook, getItems, pushUserItem, setRunning } = setup();
      act(() => setRunning(true));
      pushUserItem("first", true);
      act(() => {
        hook.result.current.handleEvent(
          ev("queued", { count: 1, messages: [{ id: "a", text: "first" }] }),
        );
      });

      // User sends a second message; its bubble exists before the sidecar acks.
      pushUserItem("second", true);
      // A stale snapshot arrives listing only the first message.
      act(() => {
        hook.result.current.handleEvent(
          ev("queued", { count: 1, messages: [{ id: "a", text: "first" }] }),
        );
      });

      const users = getItems().filter((it) => it.kind === "user");
      expect(users[1]?.queued).toBe(true);
    });

    it("forgets acknowledged queue texts on session reset", () => {
      const { hook, getItems, pushUserItem, setRunning } = setup();
      act(() => setRunning(true));
      pushUserItem("recycled", true);
      act(() => {
        hook.result.current.handleEvent(
          ev("queued", { count: 1, messages: [{ id: "a", text: "recycled" }] }),
        );
      });
      act(() => {
        hook.result.current.handleEvent(ev("session_reset"));
      });

      // Same text queued again in the FRESH session, not yet acked.
      pushUserItem("recycled", true);
      act(() => {
        hook.result.current.handleEvent(ev("queued", { count: 0, messages: [] }));
      });

      expect(getItems().find((it) => it.kind === "user")?.queued).toBe(true);
    });

    it("leaves already-sent bubbles untouched", () => {
      const { hook, getItems, pushUserItem, setRunning } = setup();
      act(() => setRunning(true));
      pushUserItem("sent normally", false);

      act(() => {
        hook.result.current.handleEvent(ev("queued", { count: 0, messages: [] }));
      });

      expect(getItems().find((it) => it.kind === "user")?.queued).toBe(false);
    });
  });

  it("removes the notice when compaction is skipped", () => {
    const { hook, getItems } = setup();

    act(() => {
      hook.result.current.handleEvent(ev("compaction_start", { messageCount: 466 }));
      hook.result.current.handleEvent(
        ev("compaction_end", { compacted: false, originalCount: 466, newCount: 466 }),
      );
    });

    expect(getItems()).toEqual([]);
  });

  it("completes the notice when messages were compacted", () => {
    const { hook, getItems } = setup();

    act(() => {
      hook.result.current.handleEvent(ev("compaction_start", { messageCount: 466 }));
      hook.result.current.handleEvent(
        ev("compaction_end", { compacted: true, originalCount: 466, newCount: 42 }),
      );
    });

    expect(getItems()).toEqual([
      expect.objectContaining({
        kind: "compaction",
        status: "done",
        originalCount: 466,
        newCount: 42,
      }),
    ]);
  });

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

  it("refreshes branch and uncommitted-file count from workspace extras", () => {
    const { hook, getState } = setup();

    act(() => {
      hook.result.current.handleEvent(
        ev("extras", { gitBranch: "feature/dirty", isGitRepo: true, gitDirtyFileCount: 4 }),
      );
    });

    expect(getState()).toMatchObject({
      gitBranch: "feature/dirty",
      isGitRepo: true,
      gitDirtyFileCount: 4,
    });
  });

  it("merges CI updates, preserves them in partial frames, and clears them on null", () => {
    const { hook, getState } = setup();
    const ci: NonNullable<AgentState["gitHubCI"]> = {
      key: "repo:sha:1.1",
      url: "https://github.com/owner/repo/actions/runs/1",
      active: true,
      total: 6,
      completed: 4,
      failed: 0,
      conclusion: null,
    };
    act(() => hook.result.current.handleEvent(ev("extras", { gitHubCI: ci })));
    expect(getState()?.gitHubCI).toEqual(ci);
    act(() => hook.result.current.handleEvent(ev("extras", { gitDirtyFileCount: 1 })));
    expect(getState()?.gitHubCI).toEqual(ci);
    act(() => hook.result.current.handleEvent(ev("extras", { gitHubCI: null })));
    expect(getState()?.gitHubCI).toBeNull();
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

  it("keeps raw diagnostics out of chat without interrupting plan progress", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: "[DONE:2]" }));
      hook.result.current.handleEvent(
        ev("diagnostics", { text: "Diagnostics in a.ts: type mismatch" }),
      );
      hook.result.current.handleEvent(ev("text_delta", { text: "Continuing step 3." }));
      hook.result.current.endStreamingText();
    });
    expect(getItems()).toEqual([
      expect.objectContaining({ kind: "assistant", text: "[DONE:2]Continuing step 3." }),
    ]);
  });

  it("does not add chat rows for repeated diagnostic or timeout notices", () => {
    const { hook, getItems } = setup();
    act(() => {
      for (const text of [
        "Post-edit diagnostics for the latest queued changes:\nL16:30 Expected 1 arguments, but got 4.",
        "a.ts: diagnostics timeout; not verified. Run the project checks.",
        "a.ts: diagnostics timeout; not verified. Run the project checks.",
      ]) {
        hook.result.current.handleEvent(ev("diagnostics", { text }));
      }
    });
    expect(getItems()).toEqual([]);
  });

  it("does not release an armed final draft when diagnostics arrive", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("hook_armed", { kind: "verification", armed: true }));
      hook.result.current.handleEvent(ev("text_delta", { text: "Unverified draft" }));
      hook.result.current.handleEvent(
        ev("diagnostics", { text: "Diagnostics in a.ts: type mismatch" }),
      );
    });
    expect(getItems()).toEqual([]);
    act(() => {
      hook.result.current.handleEvent(ev("hook", { kind: "verification" }));
      hook.result.current.handleEvent(ev("hook_armed", { kind: "verification", armed: false }));
      hook.result.current.endStreamingText();
    });
    expect(getItems().some((item) => item.kind === "assistant")).toBe(false);
  });

  it("discards a draft the late-arming fallback could not hold back", () => {
    const { hook, getItems } = setup();

    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: "Unreviewed draft" }));
      hook.result.current.handleEvent(ev("text_delta", { text: " tail" }));
      hook.result.current.handleEvent(ev("hook", { kind: "ideal" }));
    });
    expect(getItems()).toEqual([expect.objectContaining({ kind: "hook", hook: "ideal" })]);

    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: "Reviewed final" }));
      hook.result.current.endStreamingText();
    });
    expect(getItems()).toEqual([
      expect.objectContaining({ kind: "hook", hook: "ideal" }),
      expect.objectContaining({ kind: "assistant", text: "Reviewed final" }),
    ]);
  });

  it("discards every repeated draft but shows the review notice once", () => {
    // One review injects up to four times (the read-coverage retries and their
    // escalation). Each injection must kill the draft it interrupts, but the
    // notice is the same sentence — stacking copies says nothing new.
    const { hook, getItems } = setup();

    act(() => {
      hook.result.current.handleEvent(ev("hook", { kind: "ideal" }));
      hook.result.current.handleEvent(ev("text_delta", { text: "Draft two" }));
      hook.result.current.handleEvent(ev("hook", { kind: "ideal" }));
      hook.result.current.handleEvent(ev("text_delta", { text: "Draft three" }));
      hook.result.current.handleEvent(ev("hook", { kind: "ideal" }));
    });
    expect(getItems()).toEqual([expect.objectContaining({ kind: "hook", hook: "ideal" })]);

    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: "Reviewed final" }));
      hook.result.current.endStreamingText();
    });
    expect(getItems()).toEqual([
      expect.objectContaining({ kind: "hook", hook: "ideal" }),
      expect.objectContaining({ kind: "assistant", text: "Reviewed final" }),
    ]);
  });

  it("distinguishes a post-edit recheck while deduplicating repeated recheck notices", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("hook", { kind: "verification" }));
      hook.result.current.handleEvent(
        ev("hook", { kind: "verification", verificationReason: "recheck" }),
      );
      hook.result.current.handleEvent(
        ev("hook", { kind: "verification", verificationReason: "recheck" }),
      );
    });
    expect(getItems()).toHaveLength(2);
    expect(getItems()[1]).toMatchObject({ hook: "verification", verificationReason: "recheck" });
  });

  it("keeps check-review notices distinct and shows the completed outcome after the hook", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleEvent(ev("hook", { kind: "verification" }));
      hook.result.current.handleEvent(ev("hook_armed", { kind: "verification", armed: true }));
      hook.result.current.handleEvent(ev("text_delta", { text: "Unreviewed draft" }));
      hook.result.current.handleEvent(
        ev("hook", { kind: "verification", verificationReason: "check_review" }),
      );
      hook.result.current.handleEvent(
        ev("hook", { kind: "verification", verificationReason: "check_review" }),
      );
      hook.result.current.handleEvent(ev("hook_armed", { kind: "verification", armed: false }));
      hook.result.current.handleEvent(
        ev("text_delta", {
          text: "Two fixes complete. Tests pass. Commit and push remain paused.",
        }),
      );
      hook.result.current.endStreamingText();
    });
    expect(getItems()).toEqual([
      expect.objectContaining({ kind: "hook", hook: "verification" }),
      expect.objectContaining({
        kind: "hook",
        hook: "verification",
        verificationReason: "check_review",
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "Two fixes complete. Tests pass. Commit and push remain paused.",
      }),
    ]);
  });

  it("retains an evidence limitation on an approved plan marker", () => {
    const { hook, getItems } = setup();
    act(() =>
      hook.result.current.handleEvent(
        ev("autopilot_plan_accepted", { reason: "Corpus unavailable." }),
      ),
    );
    expect(getItems()).toContainEqual(
      expect.objectContaining({
        kind: "autopilot",
        phase: "plan_approved",
        reason: "Corpus unavailable.",
      }),
    );
  });

  it("still shows a second notice when a DIFFERENT hook follows", () => {
    const { hook, getItems } = setup();

    act(() => {
      hook.result.current.handleEvent(ev("hook", { kind: "verification" }));
      hook.result.current.handleEvent(ev("hook", { kind: "ideal" }));
    });
    expect(getItems()).toEqual([
      expect.objectContaining({ kind: "hook", hook: "verification" }),
      expect.objectContaining({ kind: "hook", hook: "ideal" }),
    ]);
  });

  it("never paints the draft while the Ideal review is armed", () => {
    const { hook, getItems } = setup();

    act(() => {
      hook.result.current.handleEvent(ev("hook_armed", { kind: "ideal", armed: true }));
      hook.result.current.handleEvent(ev("text_delta", { text: "Unreviewed draft" }));
      hook.result.current.handleEvent(ev("text_delta", { text: " tail" }));
    });
    // Held, never rendered: the user cannot read text the review will replace.
    expect(getItems()).toEqual([]);

    act(() => {
      hook.result.current.handleEvent(ev("hook", { kind: "ideal" }));
      hook.result.current.handleEvent(ev("hook_armed", { kind: "ideal", armed: false }));
    });
    expect(getItems()).toEqual([expect.objectContaining({ kind: "hook", hook: "ideal" })]);

    act(() => {
      hook.result.current.handleEvent(ev("text_delta", { text: "Reviewed final" }));
      hook.result.current.endStreamingText();
    });
    expect(getItems()).toEqual([
      expect.objectContaining({ kind: "hook", hook: "ideal" }),
      expect.objectContaining({ kind: "assistant", text: "Reviewed final" }),
    ]);
  });

  it("keeps holding the draft when one of two armed hooks disarms", () => {
    const { hook, getItems } = setup();

    // Both pre-final hooks armed in the same run: verification is owed AND the
    // ideal review would fire. The sidecar arms each once, on its own edge.
    act(() => {
      hook.result.current.handleEvent(ev("hook_armed", { kind: "verification", armed: true }));
      hook.result.current.handleEvent(ev("hook_armed", { kind: "ideal", armed: true }));
      hook.result.current.handleEvent(ev("text_delta", { text: "Unverified draft" }));
    });
    expect(getItems()).toEqual([]);

    // Verification fires and disarms. Ideal is still armed and will NOT be
    // re-armed (edge-triggered), so releasing here would paint a draft the
    // review is about to delete.
    act(() => {
      hook.result.current.handleEvent(ev("hook", { kind: "verification" }));
      hook.result.current.handleEvent(ev("hook_armed", { kind: "verification", armed: false }));
      hook.result.current.handleEvent(ev("text_delta", { text: "Verified draft" }));
    });
    expect(getItems()).toEqual([expect.objectContaining({ kind: "hook", hook: "verification" })]);

    // Only the last disarm releases.
    act(() => {
      hook.result.current.handleEvent(ev("hook", { kind: "ideal" }));
      hook.result.current.handleEvent(ev("hook_armed", { kind: "ideal", armed: false }));
      hook.result.current.handleEvent(ev("text_delta", { text: "Reviewed final" }));
      hook.result.current.endStreamingText();
    });
    expect(getItems()).toEqual([
      expect.objectContaining({ kind: "hook", hook: "verification" }),
      expect.objectContaining({ kind: "hook", hook: "ideal" }),
      expect.objectContaining({ kind: "assistant", text: "Reviewed final" }),
    ]);
  });

  it("never paints the draft while the verification gate is armed", () => {
    const { hook, getItems } = setup();

    act(() => {
      hook.result.current.handleEvent(ev("hook_armed", { kind: "verification", armed: true }));
      hook.result.current.handleEvent(ev("text_delta", { text: "Unverified draft" }));
      hook.result.current.handleEvent(ev("hook", { kind: "verification" }));
      hook.result.current.handleEvent(ev("hook_armed", { kind: "verification", armed: false }));
    });
    expect(getItems()).toEqual([expect.objectContaining({ kind: "hook", hook: "verification" })]);
  });

  it("releases text held under arming when the turn calls a tool instead of stopping", () => {
    const { hook, getItems } = setup();

    act(() => {
      hook.result.current.handleEvent(ev("hook_armed", { kind: "ideal", armed: true }));
      hook.result.current.handleEvent(ev("text_delta", { text: "Checking the file" }));
      hook.result.current.handleEvent(ev("tool_call_start", { toolCallId: "t1", name: "read" }));
    });
    expect(getItems()).toEqual([
      expect.objectContaining({ kind: "assistant", text: "Checking the file" }),
    ]);
  });

  it("releases held text when the run ends without the review firing", () => {
    const { hook, getItems } = setup();

    act(() => {
      hook.result.current.handleEvent(ev("hook_armed", { kind: "ideal", armed: true }));
      hook.result.current.handleEvent(ev("text_delta", { text: "Done here" }));
      hook.result.current.handleEvent(ev("agent_done", { totalTurns: 3 }));
    });
    expect(getItems()).toEqual([expect.objectContaining({ kind: "assistant", text: "Done here" })]);
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

  it("uses sidecar plan progress as the authoritative live-file snapshot", () => {
    const { hook, deps } = setup();
    deps.planTotalRef.current = 2;
    deps.planDoneRef.current = new Set([1]);

    act(() => {
      hook.result.current.handleEvent(
        ev("plan_progress", { total: 4, completed: [1, 2, 4, 99, "3"] }),
      );
    });

    expect(deps.planTotalRef.current).toBe(4);
    expect([...deps.planDoneRef.current]).toEqual([1, 2, 4]);
  });

  it("seeds an accepted plan from the canonical total on session reset", () => {
    const { hook, deps } = setup();
    deps.pendingPlanTotalRef.current = 2;

    act(() => {
      hook.result.current.handleEvent(ev("session_reset", { planTotal: 5 }));
    });

    expect(deps.pendingPlanTotalRef.current).toBeNull();
    expect(deps.planTotalRef.current).toBe(5);
    expect(deps.planDoneRef.current.size).toBe(0);
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

  it("run_end clears completed plan progress and running state", () => {
    const { hook, deps, setRunning } = setup();
    deps.planTotalRef.current = 3;
    deps.planDoneRef.current = new Set([1, 2, 3]);

    act(() => {
      hook.result.current.handleEvent(ev("run_start"));
      hook.result.current.handleEvent(ev("run_end", { cancelled: false }));
    });

    expect(setRunning).toHaveBeenLastCalledWith(false);
    expect(deps.planTotalRef.current).toBe(0);
    expect(deps.planDoneRef.current.size).toBe(0);
  });

  it("upserts persistent async agents by agent_id through idle and interrupted states", async () => {
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
    await flushSubagents();
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

  it("preserves distinct subagent activities coalesced within one flush", async () => {
    const { hook, getItems } = setup();
    const base = {
      agent_id: "abcd1234",
      task_name: "scan auth",
      state: "running",
      started_at: 1,
      updated_at: 2,
      elapsed_ms: 10,
      turn_count: 0,
      tool_use_count: 1,
      token_usage: { input: 0, output: 0 },
    };

    act(() => {
      hook.result.current.handleEvent(
        ev("subagent_state", { ...base, current_activity: "Reading auth.ts" }),
      );
      hook.result.current.handleEvent(
        ev("subagent_state", {
          ...base,
          tool_use_count: 2,
          current_activity: "Searching token refresh",
        }),
      );
    });
    await flushSubagents();

    const group = getItems().find((item) => item.kind === "subagent_group");
    expect(group?.kind === "subagent_group" ? group.agents[0]?.activities : []).toEqual([
      "Reading auth.ts",
      "Searching token refresh",
    ]);
  });

  it("keeps late async snapshots attached to their original run group", async () => {
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
    await flushSubagents();

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

describe("models_change", () => {
  it("refreshes the picker when local-model discovery lands", async () => {
    const discovered = [
      { id: "local/ollama/gemma4:e2b", name: "gemma4:e2b (Ollama)", provider: "local" },
    ];
    vi.mocked(listModels).mockResolvedValue(discovered as never);
    const { hook, getModels } = setup();

    await act(async () => {
      hook.result.current.handleEvent(ev("models_change"));
      await Promise.resolve();
    });

    // Without this the boot scan finds the user's models and nothing ever
    // shows them until the app restarts.
    expect(listModels).toHaveBeenCalled();
    expect(getModels()).toEqual(discovered);
  });

  it("refreshes the picker when a provider is connected", async () => {
    // Connecting a provider unlocks its models; the sidecar fans models_change
    // out to every window because ~/.gg/auth.json is shared, not per-session.
    const unlocked = [
      { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" },
      { id: "gpt-6", name: "GPT-6", provider: "openai" },
    ];
    vi.mocked(listModels).mockResolvedValue(unlocked as never);
    const { hook, getModels } = setup();

    await act(async () => {
      hook.result.current.handleEvent(ev("models_change"));
      await Promise.resolve();
    });

    expect(getModels()).toEqual(unlocked);
  });

  it("keeps the existing list when the refresh itself fails", async () => {
    const seeded = [{ id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" }];
    vi.mocked(listModels).mockResolvedValue(seeded as never);
    const { hook, getModels } = setup();
    await act(async () => {
      hook.result.current.handleEvent(ev("models_change"));
      await Promise.resolve();
    });
    expect(getModels()).toEqual(seeded);

    // null = the IPC call failed. Wiping the picker on a transient failure
    // would strand the user with no way to switch models.
    vi.mocked(listModels).mockResolvedValue(null as never);
    await act(async () => {
      hook.result.current.handleEvent(ev("models_change"));
      await Promise.resolve();
    });

    expect(getModels()).toEqual(seeded);
  });

  it("clears the picker when the last provider is disconnected", async () => {
    const seeded = [{ id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" }];
    vi.mocked(listModels).mockResolvedValue(seeded as never);
    const { hook, getModels } = setup();
    await act(async () => {
      hook.result.current.handleEvent(ev("models_change"));
      await Promise.resolve();
    });
    expect(getModels()).toEqual(seeded);

    // [] is a real answer, not a failure: every provider is now disconnected.
    // Leaving the old list up would offer models that can no longer authenticate.
    vi.mocked(listModels).mockResolvedValue([] as never);
    await act(async () => {
      hook.result.current.handleEvent(ev("models_change"));
      await Promise.resolve();
    });

    expect(getModels()).toEqual([]);
  });

  describe("ask_user band", () => {
    const question = {
      id: "flag",
      question: "Flip the flag for everyone now?",
      kind: "confirm",
      options: [{ label: "Yes" }, { label: "No" }],
    };

    it("renders a question the agent is parked on", () => {
      const { hook, getItems } = setup();
      act(() => {
        hook.result.current.handleEvent(ev("ask_user", { id: "ask-1", questions: [question] }));
      });
      expect(getItems()).toEqual([
        expect.objectContaining({ kind: "ask", prompt: { id: "ask-1", questions: [question] } }),
      ]);
    });

    it("drops a malformed frame instead of rendering an unanswerable band", () => {
      const { hook, getItems } = setup();
      act(() => {
        hook.result.current.handleEvent(ev("ask_user", { id: "ask-1", questions: [] }));
        hook.result.current.handleEvent(ev("ask_user", { questions: [question] }));
      });
      expect(getItems()).toEqual([]);
    });

    // The sidecar releases parked questions only on a real abort, so only a
    // cancelled run may close a band.
    it("closes an unanswered band when the run is cancelled", () => {
      const { hook, getItems } = setup();
      act(() => {
        hook.result.current.handleEvent(ev("ask_user", { id: "ask-1", questions: [question] }));
        hook.result.current.handleEvent(ev("run_end", { cancelled: true }));
      });
      expect(getItems()).toEqual([expect.objectContaining({ kind: "ask", cancelled: true })]);
    });

    // Autopilot emits a run_end per injected round while the tool call is still
    // parked; closing there would kill a question the user can still answer and
    // strand the agent until its ten-minute timeout.
    it("leaves the band live across a normal run_end", () => {
      const { hook, getItems } = setup();
      act(() => {
        hook.result.current.handleEvent(ev("ask_user", { id: "ask-1", questions: [question] }));
        hook.result.current.handleEvent(ev("run_end", {}));
        hook.result.current.handleEvent(ev("run_end", {}));
      });
      expect(getItems()).toEqual([expect.not.objectContaining({ cancelled: true })]);
    });
  });
});
