import { describe, expect, it } from "vitest";
import { parseKenAskAnswer } from "./ken-ask-answer.js";
import type { AskQuestion } from "./ask-user.js";

const choice: AskQuestion = {
  id: "store",
  question: "Where should sessions live?",
  kind: "choice",
  options: [
    { label: "SQLite", value: "sqlite" },
    { label: "JSON files", value: "json" },
  ],
  allowOther: false,
};
const confirm: AskQuestion = { id: "go", question: "Add the test?", kind: "confirm" };
const multi: AskQuestion = {
  id: "targets",
  question: "Which platforms?",
  kind: "multi",
  options: [{ label: "macOS" }, { label: "Linux" }, { label: "Windows" }],
  allowOther: false,
};
const text: AskQuestion = { id: "name", question: "Name the flag?", kind: "text" };

describe("parseKenAskAnswer", () => {
  it("accepts a valid answer for every question kind", () => {
    const reply =
      'ANSWER\n{"store":"sqlite","go":"yes","targets":["macOS","Linux"],"name":"fastPath"}';
    expect(parseKenAskAnswer(reply, [choice, confirm, multi, text])).toEqual({
      kind: "answer",
      answers: { store: "sqlite", go: "yes", targets: ["macOS", "Linux"], name: "fastPath" },
    });
  });

  it("maps labels to option values and defaults confirm to yes/no", () => {
    const reply = 'ANSWER\n```json\n{"store":"JSON files","go":"No"}\n```';
    expect(parseKenAskAnswer(reply, [choice, confirm])).toEqual({
      kind: "answer",
      answers: { store: "json", go: "no" },
    });
  });

  it("takes free text only where the question allows it", () => {
    const open: AskQuestion = { ...choice, allowOther: undefined };
    expect(parseKenAskAnswer('ANSWER {"store":"Postgres"}', [open])).toEqual({
      kind: "answer",
      answers: { store: "Postgres" },
    });
    expect(parseKenAskAnswer('ANSWER {"store":"Postgres"}', [choice])).toMatchObject({
      kind: "human",
    });
  });

  it("falls back to HUMAN on missing, invalid or malformed answers", () => {
    expect(parseKenAskAnswer('ANSWER\n{"go":"yes"}', [choice, confirm]).kind).toBe("human");
    expect(parseKenAskAnswer('ANSWER\n{"targets":["BeOS"]}', [multi]).kind).toBe("human");
    expect(parseKenAskAnswer('ANSWER\n{"targets":[]}', [multi]).kind).toBe("human");
    expect(parseKenAskAnswer('ANSWER\n{"name":"  "}', [text]).kind).toBe("human");
    expect(parseKenAskAnswer("ANSWER\n{store: sqlite", [choice]).kind).toBe("human");
    expect(parseKenAskAnswer('ANSWER\n["sqlite"]', [choice]).kind).toBe("human");
    expect(parseKenAskAnswer('I think sqlite.\nANSWER {"store":"sqlite"}', [choice]).kind).toBe(
      "human",
    );
    expect(parseKenAskAnswer("", [choice]).kind).toBe("human");
  });

  it("carries the reason on HUMAN", () => {
    expect(parseKenAskAnswer("HUMAN\nThis drops the prod table.", [confirm])).toEqual({
      kind: "human",
      reason: "This drops the prod table.",
    });
    expect(parseKenAskAnswer("HUMAN: pricing is the user's call", [confirm])).toEqual({
      kind: "human",
      reason: "pricing is the user's call",
    });
    expect(parseKenAskAnswer("HUMAN", [confirm]).kind).toBe("human");
  });
});
