// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, SidecarEvent } from "./agent";

// The real app, review box and accept flow; only the native boundary is mocked.
mockWindows("main");
mockIPC(() => new Promise(() => {}));
const { default: App } = await import("./App");
const agent = await import("./agent");

const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  // jsdom has no matchMedia; report reduced motion so nothing waits on animation.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearMocks();
  localStorage.clear();
  if (scrollToDescriptor)
    Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  if (matchMediaDescriptor) Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
  else Reflect.deleteProperty(window, "matchMedia");
});

const PLAN = "# Plan\n\n## Steps\n1. Do the first thing\n2. Do the second thing\n";

function harness(acceptOutcome: "ok" | "refused"): {
  accepts: ReturnType<typeof vi.fn>;
  prompts: ReturnType<typeof vi.fn>;
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
    cwd: "/workspaces/plan-review",
    mode: "code",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    running: false,
  };
  const accepts = vi.fn();
  const prompts = vi.fn();
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
        return { history: [] };
      case "agent_accept_plan":
        accepts(payload);
        if (acceptOutcome === "refused") {
          return Promise.reject("cannot accept a plan while the agent is running");
        }
        return null;
      case "agent_prompt":
        prompts(payload);
        return null;
      case "plugin:log|log":
        return null;
      default:
        return new Promise(() => {});
    }
  });
  return {
    accepts,
    prompts,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

async function openReview(emit: (event: SidecarEvent) => void): Promise<void> {
  await screen.findByRole("textbox");
  act(() => emit({ type: "plan_review", data: { planPath: "/tmp/plan.md", content: PLAN } }));
  await screen.findByRole("dialog", { name: "Review plan" });
}

describe("plan review accept", () => {
  it("accepts the plan and then sends the implement prompt", async () => {
    const { accepts, prompts, emit } = harness("ok");
    render(<App />);
    await openReview(emit);

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(prompts).toHaveBeenCalledTimes(1));
    expect(accepts).toHaveBeenCalledWith(expect.objectContaining({ planPath: "/tmp/plan.md" }));
    expect(screen.queryByRole("dialog", { name: "Review plan" })).toBeNull();
  });

  it("a refused accept explains itself, sends nothing, and re-opens the box", async () => {
    // Before: the refusal was swallowed, the box closed, and "implement it now"
    // went into the planning session — or nothing happened at all.
    const { accepts, prompts, emit } = harness("refused");
    render(<App />);
    await openReview(emit);

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await screen.findByText("The plan couldn't be accepted");
    expect(accepts).toHaveBeenCalledTimes(1);
    expect(prompts).not.toHaveBeenCalled();
    const retry = await screen.findByRole("button", { name: "Accept" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });
});
