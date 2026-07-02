import { describe, it, expect } from "vitest";
import { parseAutopilotVerdict } from "./autopilot-verdict.js";

describe("parseAutopilotVerdict", () => {
  it("parses ALL_CLEAR", () => {
    expect(parseAutopilotVerdict("ALL_CLEAR")).toEqual({ kind: "all_clear" });
  });

  it("parses fuzzy ALL CLEAR (space + lowercase)", () => {
    expect(parseAutopilotVerdict("all clear")).toEqual({ kind: "all_clear" });
    expect(parseAutopilotVerdict("All Clear\nlooks good")).toEqual({ kind: "all_clear" });
  });

  it("parses IGNORE", () => {
    expect(parseAutopilotVerdict("IGNORE")).toEqual({ kind: "ignore" });
  });

  it("parses fuzzy IGNORE (lowercase, trailing colon, extra text)", () => {
    expect(parseAutopilotVerdict("ignore")).toEqual({ kind: "ignore" });
    expect(parseAutopilotVerdict("Ignore:\nnothing to review")).toEqual({ kind: "ignore" });
  });

  it("parses SKIP as an alias for IGNORE", () => {
    expect(parseAutopilotVerdict("SKIP")).toEqual({ kind: "ignore" });
  });

  it("parses PROMPT with a multi-line body", () => {
    const reply = "PROMPT\nAdd a test for the login flow.\nRun it and confirm it passes.";
    expect(parseAutopilotVerdict(reply)).toEqual({
      kind: "prompt",
      body: "Add a test for the login flow.\nRun it and confirm it passes.",
    });
  });

  it("tolerates a PROMPT: keyword with a colon", () => {
    expect(parseAutopilotVerdict("PROMPT:\nFix the off-by-one in pagination.")).toEqual({
      kind: "prompt",
      body: "Fix the off-by-one in pagination.",
    });
  });

  it("parses inline PROMPT body on the keyword line", () => {
    expect(parseAutopilotVerdict("PROMPT: Fix the failing build.")).toEqual({
      kind: "prompt",
      body: "Fix the failing build.",
    });
  });

  it("strips a ```prompt fence Ken wrapped the body in", () => {
    const reply = "PROMPT\n```prompt\nWire the button to the handler.\n```";
    expect(parseAutopilotVerdict(reply)).toEqual({
      kind: "prompt",
      body: "Wire the button to the handler.",
    });
  });

  it("strips a plain ``` fence", () => {
    const reply = "PROMPT\n```\nAdd error handling to the fetch call.\n```";
    expect(parseAutopilotVerdict(reply)).toEqual({
      kind: "prompt",
      body: "Add error handling to the fetch call.",
    });
  });

  it("downgrades an empty PROMPT to human", () => {
    const v = parseAutopilotVerdict("PROMPT\n\n");
    expect(v.kind).toBe("human");
  });

  it("parses HUMAN with a reason", () => {
    expect(parseAutopilotVerdict("HUMAN\nThe requirement is ambiguous.")).toEqual({
      kind: "human",
      reason: "The requirement is ambiguous.",
    });
  });

  it("parses inline HUMAN reason on the keyword line", () => {
    expect(parseAutopilotVerdict("HUMAN: need a design decision")).toEqual({
      kind: "human",
      reason: "need a design decision",
    });
  });

  it("gives HUMAN a default reason when none provided", () => {
    const v = parseAutopilotVerdict("HUMAN");
    expect(v.kind).toBe("human");
    if (v.kind === "human") expect(v.reason.length).toBeGreaterThan(0);
  });

  it("falls back to human on an unrecognized reply", () => {
    const v = parseAutopilotVerdict("looks great, ship it!");
    expect(v.kind).toBe("human");
    if (v.kind === "human") expect(v.reason).toContain("looks great");
  });

  it("falls back to human on an empty reply", () => {
    expect(parseAutopilotVerdict("").kind).toBe("human");
    expect(parseAutopilotVerdict("   \n  ").kind).toBe("human");
  });

  it("skips leading blank lines before the keyword", () => {
    expect(parseAutopilotVerdict("\n\nALL_CLEAR")).toEqual({ kind: "all_clear" });
  });

  it("recovers ALL_CLEAR when Ken adds commentary before a trailing bare keyword line", () => {
    const reply =
      "The label is now a plain non-clickable <span>, model name is the separate " +
      "clickable button. Matches the request exactly. Typecheck passed.\nALL_CLEAR";
    expect(parseAutopilotVerdict(reply)).toEqual({ kind: "all_clear" });
  });

  it("recovers IGNORE from a trailing bare keyword line after commentary", () => {
    const reply = "Just a formatting fix, nothing to review here.\nIGNORE";
    expect(parseAutopilotVerdict(reply)).toEqual({ kind: "ignore" });
  });

  it("does NOT recover a PROMPT or HUMAN keyword from a later line — only bare ALL_CLEAR/IGNORE", () => {
    // PROMPT/HUMAN carry a payload that can't be safely recovered from an
    // arbitrary position in surrounding prose, so this still falls to human.
    const reply = "Some commentary about the change.\nPROMPT\nFix the bug.";
    const v = parseAutopilotVerdict(reply);
    expect(v.kind).toBe("human");
  });
});
