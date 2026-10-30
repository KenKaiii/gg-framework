import { describe, expect, it } from "vitest";
import deckCss from "./Deck.css?raw";

function ruleBody(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css)?.[1];
}

describe("Deck tool panels", () => {
  it("fit dialogs with a fixed width to the panel, so text wraps inside it", () => {
    for (const dialog of [".notes-modal", ".goal-modal"]) {
      expect(ruleBody(deckCss, `.tool-body > ${dialog}`)).toMatch(/width:\s*auto/);
    }
  });
});
