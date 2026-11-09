import { describe, expect, it } from "vitest";
import { chatTitle, firstUserPrompt } from "./chat-title";
import type { Item } from "./transcript-item";

describe("chatTitle", () => {
  it("cuts the first prompt to 10 characters", () => {
    expect(chatTitle("Plan my trip to Bali")).toBe("Plan my tr\u2026");
    expect(chatTitle("  Hi   there ")).toBe("Hi there");
    expect(chatTitle("0123456789")).toBe("0123456789");
    expect(chatTitle("Plan my  \n  trip")).toBe("Plan my tr\u2026");
  });

  it("never splits an emoji and names an empty chat", () => {
    expect(chatTitle("\u{1F600}".repeat(12))).toBe(`${"\u{1F600}".repeat(10)}\u2026`);
    expect(chatTitle("")).toBe("New chat");
    expect(chatTitle(undefined)).toBe("New chat");
  });
});

describe("firstUserPrompt", () => {
  it("skips Ken turns and returns the first prompt the user sent", () => {
    const items = [
      { kind: "user", id: 1, text: "Ask Ken", ken: true },
      { kind: "assistant", id: 2, text: "Hello" },
      { kind: "user", id: 3, text: "Plan my week" },
      { kind: "user", id: 4, text: "Later" },
    ] as Item[];
    expect(firstUserPrompt(items)).toBe("Plan my week");
    expect(firstUserPrompt([])).toBeNull();
  });
});
