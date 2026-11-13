import { describe, expect, it } from "vitest";
import { followDraftEdit, rebaseSegments } from "./PromptEnhancement";

describe("rebaseSegments", () => {
  const ts = { kind: "term", text: "TypeScript", original: "type script" } as const;
  const effect = { kind: "term", text: "useEffect", original: "use effect" } as const;
  const segments = [
    { kind: "text", text: "Use " },
    ts,
    { kind: "text", text: " with " },
    effect,
    { kind: "text", text: " here" },
  ] as const;
  const plain = "Use TypeScript with useEffect here";

  it.each([
    {
      name: "keeps every term when text is appended",
      next: `${plain} please`,
      want: [
        { kind: "text", text: "Use " },
        ts,
        { kind: "text", text: " with " },
        effect,
        { kind: "text", text: " here please" },
      ],
    },
    {
      name: "shifts later terms when text is inserted before them",
      next: "Now use TypeScript with useEffect here",
      want: [
        { kind: "text", text: "Now use " },
        ts,
        { kind: "text", text: " with " },
        effect,
        { kind: "text", text: " here" },
      ],
    },
    {
      name: "drops only the term an edit touches",
      next: "Use TypeScript with useLayoutEffect here",
      want: [
        { kind: "text", text: "Use " },
        ts,
        { kind: "text", text: " with useLayoutEffect here" },
      ],
    },
    {
      name: "keeps terms when the text between them is replaced",
      next: "Use TypeScript and useEffect here",
      want: [
        { kind: "text", text: "Use " },
        ts,
        { kind: "text", text: " and " },
        effect,
        { kind: "text", text: " here" },
      ],
    },
    {
      name: "realigns to the trimmed text a sent bubble shows",
      next: "Use TypeScript with useEffect",
      want: [{ kind: "text", text: "Use " }, ts, { kind: "text", text: " with " }, effect],
    },
  ])("$name", ({ next, want }) => {
    const got = rebaseSegments(segments, plain, next);
    expect(got).toEqual(want);
    expect(got?.map((seg) => seg.text).join("")).toBe(next);
  });

  it("returns null when an edit removes every term", () => {
    expect(rebaseSegments(segments, plain, "Something else entirely")).toBeNull();
  });

  it("returns null when the segments don't describe the previous text", () => {
    expect(rebaseSegments(segments, "Different text", `${plain}!`)).toBeNull();
  });
});

describe("followDraftEdit", () => {
  const segments = [
    { kind: "term", text: "TypeScript", original: "type script" },
    { kind: "text", text: " rocks" },
  ] as const;
  const enhancement = {
    enhanced: "TypeScript rocks",
    plain: "TypeScript rocks",
    segments: [...segments],
  };

  it("keeps the enhancer output while following the edited draft", () => {
    expect(followDraftEdit(enhancement, "TypeScript rocks", "TypeScript rocks!")).toEqual({
      enhanced: "TypeScript rocks",
      plain: "TypeScript rocks!",
      segments: [segments[0], { kind: "text", text: " rocks!" }],
    });
  });

  it("drops a stale enhancement that no longer matches the draft", () => {
    expect(followDraftEdit(enhancement, "Other draft", "Other draft!")).toBeNull();
  });

  it("returns null when there is no enhancement", () => {
    expect(followDraftEdit(null, "a", "ab")).toBeNull();
  });
});
