// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelSelect, loadModelsWithRetry, loadModelsInto } from "./ModelSelect";
import { supportsNativeSelectPopup } from "./platform";
import type { ModelOption } from "./agent";

vi.mock("./platform", () => ({ supportsNativeSelectPopup: vi.fn() }));

const supportsNativeMock = vi.mocked(supportsNativeSelectPopup);

const MODELS: ModelOption[] = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai" },
  { id: "grok-4.5", name: "Grok 4.5", provider: "xai" },
  {
    id: "local/ollama/gemma4:e2b",
    name: "gemma4:e2b",
    provider: "local",
    local: true,
    endpoint: "Ollama",
    supportsTools: true,
    contextWindow: 131072,
  },
  {
    id: "local/ollama/tiny",
    name: "tiny",
    provider: "local",
    local: true,
    endpoint: "Ollama",
    supportsTools: false,
    contextWindow: 8192,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ModelSelect — compact recovery action", () => {
  it.each([true, false])("keeps selection behavior with an action label (native=%s)", (native) => {
    supportsNativeMock.mockReturnValue(native);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="claude-sonnet-5"
        onSelect={vi.fn()}
        title="Switch model"
        label="Choose model"
      />,
    );
    expect(screen.getByText("Choose model")).toBeTruthy();
    if (native)
      expect(screen.getByRole("combobox").getAttribute("aria-label")).toBe("Switch model");
    else expect(screen.getByRole("button", { name: "Choose model" })).toBeTruthy();
  });
});

describe("ModelSelect — models that change what you pay", () => {
  const paid: ModelOption = {
    id: "claude-opus-5-5-fast",
    name: "Claude Opus 5.5 Fast",
    provider: "anthropic",
    billing: {
      label: "bills usage credits",
      detail: "Fast mode bills your Claude usage credits, never your plan's included usage.",
      paid: true,
    },
  };
  const planFast: ModelOption = {
    id: "gpt-6-luna-fast",
    name: "GPT-6 Luna Fast",
    provider: "openai",
    billing: { label: "2.5x plan usage", detail: "Uses plan limits at 2.5x.", paid: false },
  };

  it.each([true, false])(
    "never offers a real-money model it can't confirm, but labels plan-usage tiers (native=%s)",
    (native) => {
      supportsNativeMock.mockReturnValue(native);
      render(
        <ModelSelect
          models={[...MODELS, paid, planFast]}
          currentModel="claude-sonnet-5"
          onSelect={vi.fn()}
          title="Switch model"
          label="Choose model"
        />,
      );
      if (!native) fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
      const role = native ? "option" : "menuitemradio";
      expect(screen.queryByRole(role, { name: /Claude Opus 5\.5 Fast/ })).toBeNull();
      expect(screen.getByRole(role, { name: "GPT-6 Luna Fast · 2.5x plan usage" })).toBeTruthy();
    },
  );

  it("still shows a real-money model that is already the current one", () => {
    supportsNativeMock.mockReturnValue(false);
    render(
      <ModelSelect
        models={[...MODELS, paid]}
        currentModel="claude-opus-5-5-fast"
        onSelect={vi.fn()}
        title="Switch model"
        label="Choose model"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    expect(
      screen.getByRole("menuitemradio", { name: "Claude Opus 5.5 Fast · bills usage credits" }),
    ).toBeTruthy();
  });
});

describe("ModelSelect — native popup", () => {
  it("groups every provider under its own label, local last", () => {
    supportsNativeMock.mockReturnValue(true);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="claude-sonnet-5"
        onSelect={vi.fn()}
        title="Switch model"
      />,
    );

    const groups = Array.from(document.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toEqual(["Anthropic", "OpenAI", "xAI (Grok)", "Local · Ollama"]);
  });

  it("disables a tool-less local option and says why in its label", () => {
    supportsNativeMock.mockReturnValue(true);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="claude-sonnet-5"
        onSelect={vi.fn()}
        title="Switch model"
      />,
    );

    const option = screen.getByRole("option", { name: /^tiny — no tool calling/ });
    expect(option.hasAttribute("disabled")).toBe(true);
  });

  it("names the endpoint in the tooltip while a local model is active", () => {
    supportsNativeMock.mockReturnValue(true);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="local/ollama/gemma4:e2b"
        onSelect={vi.fn()}
        title="Switch model"
      />,
    );

    expect(screen.getByLabelText("Switch model").getAttribute("title")).toBe(
      "Switch model — Ollama",
    );
  });
});

describe("loadModelsWithRetry", () => {
  // Platform-independent: the picker is disabled whenever the list is empty, on
  // every OS. Sleep is stubbed out so the backoff does not slow the suite.
  it("retries a failed model load instead of leaving the picker dead all session", async () => {
    // The list loads once per session and an empty list disables the picker, so
    // giving up after one failure stranded the user with no way to switch.
    const fetchModels = vi
      .fn<() => Promise<ModelOption[] | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([])
      .mockResolvedValue(MODELS);

    const loaded = await loadModelsWithRetry(fetchModels, async () => {});

    expect(loaded).toEqual(MODELS);
    expect(fetchModels).toHaveBeenCalledTimes(3);
  });

  it("gives up after a bounded number of tries, so boot cannot hang", async () => {
    const fetchModels = vi.fn<() => Promise<ModelOption[] | null>>().mockResolvedValue(null);

    const loaded = await loadModelsWithRetry(fetchModels, async () => {});

    // Still null, but hydrate keeps whatever the picker already had rather
    // than blocking the session opening.
    expect(loaded).toBeNull();
    expect(fetchModels).toHaveBeenCalledTimes(4);
  });
});

describe("loadModelsInto", () => {
  const OTHER_PROJECT_MODELS = [
    { id: "gpt-5", name: "GPT-5", provider: "openai" },
  ] as unknown as ModelOption[];

  it("drops a stale load that resolves after the project was switched", async () => {
    // The load is fire-and-forget, so the PREVIOUS sidecar's retries can still
    // be running when the user switches project. Applying that late answer
    // would leave the picker listing a project the user already left.
    let generation = 0;
    const startGeneration = ++generation;
    const apply = vi.fn();

    // The stale load answers only after a second hydrate has bumped the
    // generation — exactly the ordering the guard exists for.
    const fetchModels = vi
      .fn<() => Promise<ModelOption[] | null>>()
      .mockImplementation(async () => {
        generation++;
        return MODELS;
      });

    await loadModelsInto(
      fetchModels,
      apply,
      () => generation !== startGeneration,
      async () => {},
    );

    expect(apply).not.toHaveBeenCalled();
  });

  it("applies the newest hydrate's result", async () => {
    const apply = vi.fn();

    await loadModelsInto(
      async () => OTHER_PROJECT_MODELS,
      apply,
      () => false,
      async () => {},
    );

    expect(apply).toHaveBeenCalledWith(OTHER_PROJECT_MODELS);
  });

  it("leaves the picker untouched when every attempt failed, and reports it", async () => {
    const apply = vi.fn();

    const ok = await loadModelsInto(
      async () => null,
      apply,
      () => false,
      async () => {},
    );

    expect(apply).not.toHaveBeenCalled();
    expect(ok).toBe(false);
  });

  it("reports success when the list was applied or dropped as stale", async () => {
    const applied = await loadModelsInto(
      async () => MODELS,
      vi.fn(),
      () => false,
      async () => {},
    );
    const stale = await loadModelsInto(
      async () => MODELS,
      vi.fn(),
      () => true,
      async () => {},
    );

    expect(applied).toBe(true);
    expect(stale).toBe(true);
  });
});

describe("ModelSelect — failed model load", () => {
  it("says the load failed instead of claiming it is still connecting", () => {
    supportsNativeMock.mockReturnValue(false);
    render(
      <ModelSelect
        models={[]}
        currentModel="claude-sonnet-5"
        onSelect={vi.fn()}
        title="Switch model"
        loadFailed
      />,
    );

    expect(screen.getByTitle(/Couldn't load models from the agent/)).toBeTruthy();
    expect(screen.queryByTitle(/still connecting/)).toBeNull();
  });
});

describe("ModelSelect — in-webview menu", () => {
  function openMenu(current = "claude-sonnet-5", onSelect = vi.fn()) {
    supportsNativeMock.mockReturnValue(false);
    render(
      <ModelSelect
        models={MODELS}
        currentModel={current}
        onSelect={onSelect}
        title="Switch model"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Claude Sonnet 5|gemma4/ }));
    return onSelect;
  }

  it("says why it is locked instead of going silently inert", () => {
    supportsNativeMock.mockReturnValue(false);
    render(
      <ModelSelect
        models={MODELS}
        currentModel="claude-sonnet-5"
        onSelect={vi.fn()}
        disabled
        title="Switch model"
      />,
    );

    // Plain footer text gives a disabled control no visual tell, so the reason
    // has to be in the tooltip — not the tooltip's usual "Switch model".
    const trigger = screen.getByRole("button", { name: /Claude Sonnet 5/ });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.getAttribute("title")).toContain("while the agent is running");
  });

  it("renders one titled section per provider, local last", () => {
    openMenu();

    const headings = Array.from(document.querySelectorAll(".model-menu-subtitle")).map(
      (el) => el.textContent,
    );
    expect(headings).toEqual(["Anthropic", "OpenAI", "xAI (Grok)", "Local · Ollama"]);
    // Each section's grid is labelled for screen readers.
    expect(screen.getByRole("group", { name: "Local · Ollama" })).toBeTruthy();
  });

  it("selects a model from its provider group", () => {
    const onSelect = openMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Grok 4.5" }));

    expect(onSelect).toHaveBeenCalledWith("grok-4.5");
  });

  it("refuses to select a tool-less local model", () => {
    const onSelect = openMenu();

    const item = screen.getByRole("menuitemradio", { name: "tiny" });
    expect(item.hasAttribute("disabled")).toBe(true);
    expect(item.getAttribute("title")).toContain("has no tool calling");

    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks the active model as checked", () => {
    openMenu("local/ollama/gemma4:e2b");

    expect(
      screen.getByRole("menuitemradio", { name: "gemma4:e2b" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});
