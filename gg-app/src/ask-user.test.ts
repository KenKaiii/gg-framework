import { describe, expect, it } from "vitest";
import { isAskUserPrompt } from "./ask-user";

describe("isAskUserPrompt", () => {
  it("accepts questions with and without options", () => {
    const prompt = {
      id: "ask-1",
      questions: [
        { id: "a", kind: "confirm", question: "Go?", options: [{ label: "Yes" }] },
        { id: "b", kind: "text", question: "Why?" },
      ],
    };
    expect(isAskUserPrompt(prompt)).toBe(true);
  });

  it("rejects a question whose options are not a list", () => {
    const prompt = {
      id: "ask-1",
      questions: [{ id: "a", kind: "confirm", question: "Go?", options: "[CIRCULAR]" }],
    };
    expect(isAskUserPrompt(prompt)).toBe(false);
  });
});
