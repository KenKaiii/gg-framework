// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { updateGoal, type GoalStateInfo, type ModelOption } from "../agent";
import type { Item } from "../transcript-item";
import { GoalPanel } from "./GoalPanel";

vi.mock("../agent", () => ({ updateGoal: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const GOAL: GoalStateInfo = {
  id: "api-latency",
  name: "API latency",
  needsKickoff: false,
  phase: "active",
  critterModel: null,
};
const MODELS: ModelOption[] = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic" },
  { id: "gpt-6", name: "GPT-6", provider: "openai" },
  {
    id: "claude-opus-5-5-fast",
    name: "Claude Opus 5.5 Fast",
    provider: "anthropic",
    billing: {
      label: "bills usage credits",
      detail: "",
      paid: true,
      standardModel: "claude-opus-5-5",
    },
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const base = {
  view: "workers" as const,
  onViewChange: vi.fn(),
  models: MODELS,
  onSelectWorkerModel: vi.fn(),
};

describe("GoalPanel", () => {
  it("switches between the chat and the workers once the goal is underway", () => {
    const onViewChange = vi.fn();
    render(
      <GoalPanel
        goal={GOAL}
        view="workers"
        onViewChange={onViewChange}
        needsAnswer
        models={MODELS}
        onSelectWorkerModel={vi.fn()}
      />,
    );
    expect(screen.getByText("Underway")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Workers" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat (waiting for you)" }));
    expect(onViewChange).toHaveBeenCalledWith("chat");
  });

  it("has no view switch while the goal is being briefed", () => {
    render(
      <GoalPanel
        goal={{ ...GOAL, phase: "briefing" }}
        view={null}
        onViewChange={vi.fn()}
        models={MODELS}
        onSelectWorkerModel={vi.fn()}
      />,
    );
    expect(screen.getByText("Briefing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Workers" })).toBeNull();
  });

  it("pins the workers' model, and clears it back to the coordinator's", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <GoalPanel
        goal={GOAL}
        view="chat"
        onViewChange={vi.fn()}
        models={MODELS}
        onSelectWorkerModel={onSelect}
      />,
    );
    const select = screen.getByLabelText("Workers' model") as HTMLSelectElement;
    expect(select.value).toBe("");
    // Paid tiers are only for the main chat.
    expect(screen.queryByRole("option", { name: "Claude Opus 5.5 Fast" })).toBeNull();
    fireEvent.change(select, { target: { value: "gpt-6" } });
    expect(onSelect).toHaveBeenLastCalledWith("gpt-6");

    rerender(
      <GoalPanel
        goal={{ ...GOAL, critterModel: "gpt-6" }}
        view="chat"
        onViewChange={vi.fn()}
        models={MODELS}
        onSelectWorkerModel={onSelect}
      />,
    );
    fireEvent.change(select, { target: { value: "" } });
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("counts the workers and tasks, and pauses a running goal", () => {
    const onPauseChange = vi.fn();
    render(
      <GoalPanel
        {...base}
        goal={GOAL}
        running
        onPauseChange={onPauseChange}
        groups={[
          {
            id: 1,
            agents: [
              { toolCallId: "a", status: "running", activities: [], toolUseCount: 0 },
              { toolCallId: "b", status: "done", activities: [], toolUseCount: 0 },
              { toolCallId: "c", status: "error", activities: [], toolUseCount: 0 },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText("1 working · 1 done · 1 failed")).toBeTruthy();
    // The status pill says what the coordinator is doing.
    expect(screen.getByText("Thinking")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause the goal" }));
    expect(onPauseChange).toHaveBeenCalledWith(true);
  });

  it("offers to resume a paused goal, and to carry on a stopped one", () => {
    const onPauseChange = vi.fn();
    const { rerender } = render(
      <GoalPanel {...base} goal={{ ...GOAL, paused: true }} onPauseChange={onPauseChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume the goal" }));
    expect(onPauseChange).toHaveBeenLastCalledWith(false);
    rerender(<GoalPanel {...base} goal={GOAL} onPauseChange={onPauseChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Not running. Carry the goal on" }));
    expect(onPauseChange).toHaveBeenLastCalledWith(false);
  });

  it("says what the coordinator is waiting on over the Workers view, until the chat is seen", () => {
    const onViewChange = vi.fn();
    const items = [
      {
        kind: "ask",
        id: 3,
        prompt: {
          id: "ask-1",
          questions: [
            { id: "q", kind: "confirm", question: "Ship it?" },
            { id: "r", kind: "confirm", question: "Tag it?" },
          ],
        },
      },
    ] as unknown as Item[];
    const { rerender } = render(
      <GoalPanel {...base} goal={GOAL} items={items} onViewChange={onViewChange} />,
    );
    expect(screen.getByText("Ship it?")).toBeTruthy();
    expect(screen.getByText(/And 1 more question/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Answer in Chat" }));
    expect(onViewChange).toHaveBeenCalledWith("chat");

    rerender(<GoalPanel {...base} view="chat" goal={GOAL} items={items} />);
    rerender(<GoalPanel {...base} goal={GOAL} items={items} />);
    expect(screen.queryByText("Ship it?")).toBeNull();
  });

  it("saves changed instructions, and holds changes while the goal works", async () => {
    vi.mocked(updateGoal).mockResolvedValue({ context: [], instructions: "Keep URLs." });
    const onSaved = vi.fn();
    const { rerender } = render(
      <GoalPanel {...base} goal={{ ...GOAL, instructions: "" }} running onSaved={onSaved} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Goal settings" }));
    expect(screen.getByText(/Pause it to change its settings/)).toBeTruthy();
    expect((screen.getByLabelText(/Instructions/) as HTMLTextAreaElement).disabled).toBe(true);

    rerender(<GoalPanel {...base} goal={{ ...GOAL, instructions: "" }} onSaved={onSaved} />);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Instructions/), { target: { value: " Keep URLs. " } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ context: [], instructions: "Keep URLs." }),
    );
    expect(updateGoal).toHaveBeenCalledWith({ context: [], instructions: "Keep URLs." });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("shows the finish card once a stretch of work has gone quiet", async () => {
    vi.useFakeTimers();
    try {
      const runs = [
        {
          goalId: GOAL.id,
          startedAt: 1000,
          endedAt: 5000,
          fromItemId: 0,
          turns: 4,
          outputTokens: 900,
          outcome: "done" as const,
        },
      ];
      const { rerender } = render(<GoalPanel {...base} goal={GOAL} running runs={runs} />);
      expect(screen.queryByRole("status", { name: "Job done" })).toBeNull();
      rerender(<GoalPanel {...base} goal={GOAL} runs={runs} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      expect(screen.getByRole("status", { name: "Job done" })).toBeTruthy();
      // Work starting again takes it down.
      rerender(<GoalPanel {...base} goal={GOAL} running runs={runs} />);
      expect(screen.queryByRole("status", { name: "Job done" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
