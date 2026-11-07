// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelPanel, type SecondAgent } from "./ModelPanel";
import { authStatus, openUrl, type AgentState, type AuthProvider, type ModelOption } from "./agent";

vi.mock("./agent", () => ({
  setThinkingLevel: vi.fn(() => Promise.resolve()),
  authStatus: vi.fn(() => Promise.resolve([])),
  openUrl: vi.fn(() => Promise.resolve()),
}));

// jsdom has no layout, so no `scrollIntoView` (same stub as Dropdown.test.tsx).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" },
  {
    id: "claude-opus-5-5-fast",
    name: "Claude Opus 5.5 Fast",
    provider: "anthropic",
    billing: {
      label: "bills usage credits",
      detail: "Fast mode bills your Claude usage credits from the first token.",
      paid: true,
      standardModel: "claude-opus-5-5",
    },
  },
];

const STATE = { provider: "anthropic", model: "claude-opus-5-5" } as AgentState;

function renderPanel(second: SecondAgent | null = null) {
  const onSelectModel = vi.fn();
  const onClose = vi.fn();
  render(
    <ModelPanel
      state={STATE}
      models={MODELS}
      modelsFailed={false}
      running={false}
      onSelectModel={onSelectModel}
      second={second}
      onClose={onClose}
    />,
  );
  return { onSelectModel, onClose };
}

function option(name: RegExp): HTMLElement {
  return screen.getByRole("option", { name });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ModelPanel — a model that spends real money", () => {
  it("asks first, with Cancel as the default, and never switches on its own", () => {
    const { onSelectModel, onClose } = renderPanel();
    fireEvent.click(option(/Claude Opus 5\.5 Fast/));

    expect(onSelectModel).not.toHaveBeenCalled();
    expect(screen.getByText("Claude Opus 5.5 Fast spends real money.")).toBeTruthy();
    // Names what sessions fall back to, not a Claude-only "standard speed".
    expect(screen.getByText(/go back to Claude Opus 5\.5, and Ken/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    // Enter on the focused default answer backs out instead of paying.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Claude Opus 5.5 Fast spends real money.")).toBeNull();
  });

  it("backs out on Escape", () => {
    const { onSelectModel } = renderPanel();
    fireEvent.click(option(/Claude Opus 5\.5 Fast/));
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(screen.queryByText("Claude Opus 5.5 Fast spends real money.")).toBeNull();
  });

  it("switches only after the explicit yes, and says so on the request", () => {
    const { onSelectModel, onClose } = renderPanel();
    fireEvent.click(option(/Claude Opus 5\.5 Fast/));
    fireEvent.click(screen.getByRole("button", { name: "Use it and pay" }));
    expect(onSelectModel).toHaveBeenCalledWith("claude-opus-5-5-fast", { confirmPaid: true });
    expect(onClose).toHaveBeenCalled();
  });

  it("switches a standard model straight away, with no confirmation", () => {
    const { onSelectModel } = renderPanel();
    fireEvent.click(option(/^Claude Opus 5\.5(?! Fast)/));
    expect(screen.queryByText(/spends real money/)).toBeNull();
    expect(onSelectModel).toHaveBeenCalledWith("claude-opus-5-5");
  });

  it("keeps it off Ken, who runs unwatched", () => {
    const onSelect = vi.fn();
    renderPanel({
      name: "Ken",
      followLabel: "GG",
      model: "claude-opus-5-5",
      following: true,
      disabled: false,
      onSelect,
    });
    fireEvent.click(screen.getByRole("radio", { name: /^Ken/ }));
    const paid = option(/Claude Opus 5\.5 Fast/);
    expect(paid.getAttribute("aria-disabled")).toBe("true");
    expect(paid.textContent).toContain("main chat only");
    fireEvent.click(paid);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("ModelPanel — ChatGPT plan", () => {
  function renderOpenAI() {
    render(
      <ModelPanel
        state={{ provider: "openai", model: "gpt-6.1-sol" } as AgentState}
        models={[{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai" }]}
        modelsFailed={false}
        running={false}
        onSelectModel={vi.fn()}
        second={null}
        onClose={vi.fn()}
      />,
    );
  }

  it("says when requests use the ChatGPT plan, with a Manage usage link", async () => {
    vi.mocked(authStatus).mockResolvedValue([
      { value: "openai", activeMethod: "oauth" } as AuthProvider,
    ]);
    renderOpenAI();
    const link = await screen.findByRole("link", { name: "Manage usage" });
    expect(screen.getByText(/Using ChatGPT plan/)).toBeDefined();
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledWith("https://chatgpt.com/settings/usage");
  });

  it("says nothing on an OpenAI API key", async () => {
    vi.mocked(authStatus).mockResolvedValue([
      { value: "openai", activeMethod: "apikey" } as AuthProvider,
    ]);
    renderOpenAI();
    await act(async () => {});
    expect(screen.queryByText(/Using ChatGPT plan/)).toBeNull();
  });

  it("never reads auth status for other providers", () => {
    renderPanel();
    expect(authStatus).not.toHaveBeenCalled();
  });
});

describe("ModelPanel — models the user's plan or keys can't run", () => {
  it("shows why and won't switch to them", () => {
    const onSelectModel = vi.fn();
    render(
      <ModelPanel
        state={{ provider: "openai", model: "gpt-6-luna" } as AgentState}
        models={[
          { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai" },
          {
            id: "gpt-6.1-sol",
            name: "GPT-6.1 Sol",
            provider: "openai",
            unavailable: "Not in your ChatGPT plan",
          },
        ]}
        modelsFailed={false}
        running={false}
        onSelectModel={onSelectModel}
        second={null}
        onClose={vi.fn()}
      />,
    );
    const sol = option(/GPT-6\.1 Sol/);
    expect(sol.textContent).toContain("Not in your ChatGPT plan");
    expect(sol.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(sol);
    expect(onSelectModel).not.toHaveBeenCalled();
  });
});
