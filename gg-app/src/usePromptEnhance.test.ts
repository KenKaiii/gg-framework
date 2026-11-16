// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePromptEnhance } from "./usePromptEnhance";

vi.mock("./agent", () => ({ enhancePrompt: vi.fn() }));

describe("usePromptEnhance", () => {
  it("hides the Enhance pill in the same render the input empties", () => {
    // The pill sits in the composer row, so a render that shows it beside an
    // empty input measures the field at the wrong width and flashes taller.
    const seen: Array<[string, boolean]> = [];
    const { rerender } = renderHook(
      ({ input }: { input: string }) => {
        const result = usePromptEnhance({
          input,
          setInput: vi.fn(),
          inputRef: { current: null },
          enhancing: false,
          setEnhancing: vi.fn(),
          setEnhanceAnim: vi.fn(),
          pendingEnhanceRef: { current: null },
          enhancement: null,
          setEnhancement: vi.fn(),
          hydrated: true,
          slashOpen: false,
          mentionOpen: false,
          scheduleDraft: false,
        });
        seen.push([input, result.enhanceHintVisible]);
        return result;
      },
      { initialProps: { input: "fix the bug" } },
    );
    rerender({ input: "" });
    expect(seen.find(([input]) => input === "fix the bug")?.[1]).toBe(true);
    expect(seen.filter(([input]) => input === "").every(([, visible]) => !visible)).toBe(true);
  });
});
