import { describe, expect, it } from "vitest";
import {
  deriveKenPromptTitle,
  KEN_PROMPT_FALLBACK_TITLE,
  KEN_PROMPT_TITLE_MAX_LENGTH,
  normalizeKenPrompt,
} from "./ken-prompt-actions";

describe("normalizeKenPrompt", () => {
  it("normalizes line endings and trims only the outer prompt whitespace", () => {
    expect(normalizeKenPrompt("  First line\r\n  indented detail  \r\n")).toBe(
      "First line\n  indented detail",
    );
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeKenPrompt(" \n\t ")).toBe("");
  });
});

describe("deriveKenPromptTitle", () => {
  it("uses the first meaningful line and removes common Markdown prefixes", () => {
    expect(deriveKenPromptTitle("\n## Implement the durable save boundary\nMore detail")).toBe(
      "Implement the durable save boundary",
    );
    expect(deriveKenPromptTitle("- Add keyboard support\nThen test it")).toBe(
      "Add keyboard support",
    );
  });

  it("is deterministic for equivalent line endings and outer whitespace", () => {
    const expected = deriveKenPromptTitle("Ship the prompt action boundary\nDetails");
    expect(deriveKenPromptTitle("\r\nShip the prompt action boundary\r\nDetails  ")).toBe(expected);
  });

  it("uses a useful fallback for empty input", () => {
    expect(deriveKenPromptTitle("\n\t")).toBe(KEN_PROMPT_FALLBACK_TITLE);
  });

  it("keeps generated titles within the documented bound", () => {
    const title = deriveKenPromptTitle(`Build ${"a very detailed capability ".repeat(10)}`);
    expect(title.length).toBeLessThanOrEqual(KEN_PROMPT_TITLE_MAX_LENGTH);
    expect(title.endsWith(" ")).toBe(false);
  });

  it("hard-bounds a single unbroken value", () => {
    expect(deriveKenPromptTitle("x".repeat(200))).toHaveLength(KEN_PROMPT_TITLE_MAX_LENGTH);
  });
});
