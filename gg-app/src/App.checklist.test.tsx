// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, ChecklistSnapshot, HistoryEntry, SidecarEvent } from "./agent";

mockWindows("main");
mockIPC(() => new Promise(() => {}));
const { default: App } = await import("./App");
const agent = await import("./agent");
const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
const transitionDescriptor = Object.getOwnPropertyDescriptor(document, "startViewTransition");
let composerStyles: HTMLStyleElement;
function mockTransitions(): ReturnType<typeof vi.fn> {
  const start = vi.fn((update: () => void) => {
    update();
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  return start;
}
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  // The real composer and footer use flex. Native `hidden` alone loses to
  // author display rules; hiding the chat must not depend on checklist CSS.
  composerStyles = document.createElement("style");
  composerStyles.textContent =
    ".transcript-frame, .liveregion, .inputwrap, .footer { display: flex; }";
  document.head.appendChild(composerStyles);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  composerStyles.remove();
  clearMocks();
  localStorage.clear();
  if (scrollToDescriptor)
    Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  if (transitionDescriptor)
    Object.defineProperty(document, "startViewTransition", transitionDescriptor);
  else Reflect.deleteProperty(document, "startViewTransition");
});

const CHECKLIST_PROMPT = `# Checklist: Git & GitHub

Check this project for one item of its health checklist and report in plain words.

Check and report only. Do not edit project files.

- id: \`git-github\``;

const SNAPSHOT: ChecklistSnapshot = {
  staleAfterDays: 30,
  detectionWarnings: [],
  items: [
    {
      id: "git-github",
      group: "Source control",
      title: "Git & GitHub",
      description: "Repository setup",
      check: "Inspect git",
      skill: null,
      setupCommand: null,
      status: "not-run",
      checkedAt: null,
      commit: null,
      uncommittedChanges: false,
      result: null,
      summary: null,
      findings: [],
      evidence: [],
      detection: { summary: "Git initialized", facts: ["Git repository initialized"] },
      runPrompt: CHECKLIST_PROMPT,
    },
    {
      id: "agent-setup",
      group: "Foundations",
      title: "Agent setup",
      description: "A current agent context file and useful skills.",
      check: "Inspect agent instructions",
      skill: null,
      setupCommand: "init",
      status: "not-run",
      checkedAt: null,
      commit: null,
      uncommittedChanges: false,
      result: null,
      summary: null,
      findings: [],
      evidence: [],
      detection: null,
      runPrompt: CHECKLIST_PROMPT.replace("Git & GitHub", "Agent setup"),
    },
  ],
};
function harness(history: HistoryEntry[] = []): {
  fetches: ReturnType<typeof vi.fn>;
  sends: ReturnType<typeof vi.fn>;
  emit: (event: SidecarEvent) => void;
} {
  const listeners = new Set<(event: SidecarEvent) => void>();
  vi.spyOn(agent, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const state: AgentState = {
    cwd: "/workspaces/checklist",
    mode: "code",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    running: false,
  };
  const fetches = vi.fn(() => SNAPSHOT);
  const sends = vi.fn();
  mockWindows("main");
  mockIPC((command, payload) => {
    switch (command) {
      case "window_restore_target":
        return { mode: "code", cwd: state.cwd, sessionPath: null };
      case "sidecar_port":
        return 12345;
      case "agent_state":
        return state;
      case "agent_models":
        return { models: [{ id: state.model, provider: state.provider }] };
      case "agent_commands":
        return { commands: [] };
      case "agent_tasks":
        return { tasks: [] };
      case "agent_history":
        return { history };
      case "agent_checklist":
        return fetches();
      case "agent_prompt":
        sends(payload);
        return null;
      case "plugin:log|log":
        return null;
      default:
        return new Promise(() => {});
    }
  });
  return {
    fetches,
    sends,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("checklist workspace navigation", () => {
  it.each(["reopen", "normal-chat completion"])(
    "clears a stale no-result notice after a later record on %s",
    async (refresh) => {
      const { fetches, sends, emit } = harness();
      render(<App />);
      const open = await screen.findByRole("button", { name: "Checklist" });
      fireEvent.click(open);
      fireEvent.click(await screen.findByRole("button", { name: "Check Git & GitHub" }));
      await waitFor(() => expect(sends).toHaveBeenCalledOnce());
      await act(async () => {
        emit({ type: "run_end", data: {} });
      });
      fireEvent.click(open);
      expect(
        await screen.findByText("No result recorded. View the conversation for details."),
      ).toBeTruthy();
      const recorded: ChecklistSnapshot = {
        ...SNAPSHOT,
        items: SNAPSHOT.items.map((item) =>
          item.id === "git-github"
            ? { ...item, status: "passed", result: "pass", checkedAt: "2026-10-05T12:00:00Z" }
            : item,
        ),
      };
      fetches.mockReturnValue(recorded);
      if (refresh === "reopen") {
        fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
        fireEvent.click(open);
      } else {
        await act(async () => {
          emit({ type: "run_end", data: {} });
        });
      }
      expect(await screen.findByText("Checked 5 Oct 2026")).toBeTruthy();
      expect(
        screen.queryByText("No result recorded. View the conversation for details."),
      ).toBeNull();
    },
  );

  it("ignores an older fetch that finishes after a newer record", async () => {
    const { fetches, emit } = harness();
    let resolveOld: ((snapshot: ChecklistSnapshot) => void) | undefined;
    fetches.mockReturnValueOnce(
      new Promise<ChecklistSnapshot>((resolve) => {
        resolveOld = resolve;
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Checklist" }));
    await waitFor(() => expect(fetches).toHaveBeenCalledOnce());
    fetches.mockReturnValue({
      ...SNAPSHOT,
      items: SNAPSHOT.items.map((item) => ({
        ...item,
        status: "passed",
        result: "pass",
        checkedAt: "2026-10-05T12:00:00Z",
      })),
    });
    await act(async () => {
      emit({ type: "run_end", data: {} });
    });
    await waitFor(() => expect(screen.getAllByText("Checked 5 Oct 2026")).toHaveLength(2));
    await act(async () => {
      resolveOld?.(SNAPSHOT);
    });
    expect(screen.getAllByText("Checked 5 Oct 2026")).toHaveLength(2);
    expect(screen.queryByText("Git initialized · Not reviewed")).toBeNull();
  });

  it("runs /init for Agent setup, returns to chat and keeps the draft", async () => {
    const { sends } = harness();
    render(<App />);
    const open = await screen.findByRole("button", { name: "Checklist" });
    const draft = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    fireEvent.click(open);
    fireEvent.click(await screen.findByRole("button", { name: "Check Agent setup" }));
    await waitFor(() => expect(sends).toHaveBeenCalledOnce());
    expect(sends.mock.calls[0]?.[0]).toMatchObject({ text: "/init", attachments: [] });
    expect(screen.queryByRole("region", { name: "Project checklist" })).toBeNull();
    expect(screen.getByText("/init").classList.contains("command-shimmer")).toBe(true);
    expect(screen.queryByText("Checking Agent setup")).toBeNull();
    expect(draft.value).toBe("Keep this draft");
  });
  it("restores the same shimmer label on session return and reload without exposing or recalling the full prompt", async () => {
    const history: HistoryEntry[] = [
      { role: "user", text: "Keep this real user prompt" },
      { role: "user", text: CHECKLIST_PROMPT },
      { role: "assistant", text: "The check is complete." },
    ];
    harness(history);
    // First mount resumes an existing session; the second reloads that same
    // persisted history. Neither relies on the original in-memory label.
    for (let mount = 0; mount < 2; mount++) {
      const view = render(<App />);
      const label = await screen.findByText("Checking Git & GitHub");
      expect(label.classList.contains("command-shimmer")).toBe(true);
      expect(label.closest(".user-msg")?.textContent).toBe("Checking Git & GitHub");
      expect(screen.queryByText(/Check this project for one item/)).toBeNull();
      expect(screen.getByText("Keep this real user prompt")).toBeTruthy();
      expect(screen.getByText("The check is complete.")).toBeTruthy();
      const input = screen.getByRole<HTMLTextAreaElement>("textbox");
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input.value).toBe("Keep this real user prompt");
      // Recovery is display-only; retain the complete instructions in history.
      expect(history[1]?.text).toBe(CHECKLIST_PROMPT);
      view.unmount();
    }
  });
  it("fetches after the transition commits so a fast response cannot get stuck loading", async () => {
    const { fetches } = harness();
    let commit: (() => void) | undefined;
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: (update: () => void) => {
        commit = update;
        return { ready: Promise.resolve(), finished: Promise.resolve() };
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Checklist" }));
    expect(fetches).not.toHaveBeenCalled();
    expect(commit).toBeTypeOf("function");
    act(() => commit?.());
    expect(await screen.findByText("Git initialized · Not reviewed")).toBeTruthy();
    expect(screen.queryByText("Reading project setup…")).toBeNull();
  });
  it("keeps navigation and draft, uses the existing back button, and refetches on open", async () => {
    const { fetches } = harness();
    const transitions = mockTransitions();
    render(<App />);
    const open = await screen.findByRole("button", { name: "Checklist" });
    const draft = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(draft, { target: { value: "Keep this unfinished thought" } });
    fireEvent.click(open);
    const checklist = await screen.findByRole("region", { name: "Project checklist" });
    await within(checklist).findByText("Git initialized · Not reviewed");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    for (const selector of [".transcript-frame", ".liveregion", ".inputwrap", ".footer"]) {
      const element = document.querySelector<HTMLElement>(selector);
      expect(element).not.toBeNull();
      if (element) {
        expect(getComputedStyle(element).display).toBe("none");
        expect(element.style.display).toBe("none");
      }
    }
    expect(transitions).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Tasks" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.queryByRole("region", { name: "Project checklist" })).toBeNull();
    expect(draft.value).toBe("Keep this unfinished thought");
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(document.activeElement).toBe(draft);
    expect(transitions).toHaveBeenCalledTimes(2);
    fireEvent.click(open);
    await waitFor(() => expect(fetches).toHaveBeenCalledTimes(2));
  });
  it("dissolves back to chat for the report, preserving the draft and preventing duplicate checks", async () => {
    const { sends } = harness();
    const transitions = mockTransitions();
    render(<App />);
    const open = await screen.findByRole("button", { name: "Checklist" });
    const draft = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(draft, { target: { value: "A draft before checking" } });
    fireEvent.click(open);
    fireEvent.click(await screen.findByRole("button", { name: "Check Git & GitHub" }));
    await waitFor(() => expect(sends).toHaveBeenCalledOnce());
    expect(sends.mock.calls[0]?.[0]).toMatchObject({
      text: SNAPSHOT.items[0]?.runPrompt,
      attachments: [],
    });
    expect(screen.queryByRole("region", { name: "Project checklist" })).toBeNull();
    expect(screen.queryByText("Repository setup")).toBeNull();
    expect(screen.getByText("Checking Git & GitHub").classList.contains("command-shimmer")).toBe(
      true,
    );
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(draft.value).toBe("A draft before checking");
    expect(document.activeElement).toBe(draft);
    expect(transitions).toHaveBeenCalledTimes(2);
    fireEvent.click(open);
    const check = await screen.findByRole("button", { name: "Check Git & GitHub" });
    expect(check.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
    fireEvent.click(check);
    expect(sends).toHaveBeenCalledOnce();
  });
});
