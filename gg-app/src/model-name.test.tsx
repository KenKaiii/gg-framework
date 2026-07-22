// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { modelDisplayName } from "./model-name";
import { ModelSelect } from "./ModelSelect";
import type { ModelOption } from "./agent";

// ModelSelect only imports ModelOption from ./agent as a type (erased), so the
// module's Tauri side-effects never load. Guard anyway in case that changes.
vi.mock("./agent", () => ({}));

const MODELS: ModelOption[] = [
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", provider: "gemini" },
  { id: "gemini-3-flash", name: "Gemini 3.5 Flash", provider: "gemini" },
];

afterEach(cleanup);

describe("modelDisplayName (footer label)", () => {
  it("maps the gemini-3-flash wire id to the friendly 'Gemini 3.5 Flash'", () => {
    expect(modelDisplayName(MODELS, "gemini-3-flash")).toBe("Gemini 3.5 Flash");
  });

  it("falls back to the raw id when the model isn't in the list", () => {
    expect(modelDisplayName(MODELS, "unknown-model")).toBe("unknown-model");
  });

  it("shows an ellipsis when there is no id yet", () => {
    expect(modelDisplayName(MODELS, undefined)).toBe("\u2026");
    expect(modelDisplayName(MODELS, null)).toBe("\u2026");
  });
});

describe("ModelSelect (native dropdown)", () => {
  it("renders friendly names, not raw wire ids", () => {
    render(
      <ModelSelect
        models={MODELS}
        currentModel="gemini-3-flash"
        onSelect={() => {}}
        title="Switch model"
      />,
    );
    // The closed control shows the friendly name as plain text (it also
    // appears once more as the <option> inside the hidden select)…
    expect(screen.getAllByText("Gemini 3.5 Flash").length).toBeGreaterThan(0);
    // …and the raw wire id is never shown as visible text.
    expect(screen.queryByText("gemini-3-flash")).toBeNull();
  });

  it("shows the follow choice as selected when Ken follows GG Coder", () => {
    render(
      <ModelSelect
        models={MODELS}
        currentModel="gemini-3-flash"
        onSelect={() => {}}
        title="Ken's model"
        onSelectFollow={() => {}}
        followActive
      />,
    );
    const select = screen.getByLabelText("Ken's model") as HTMLSelectElement;
    expect(select.value).toBe("__follow__");
    expect(screen.getByText("Follow GG Coder (Gemini 3.5 Flash)")).toBeDefined();
  });
});
