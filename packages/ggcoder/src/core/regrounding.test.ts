import { describe, expect, it } from "vitest";
import {
  askUserDecision,
  buildRegroundingMessage,
  recordUserDecision,
  requestTextForRegrounding,
  shouldReground,
} from "./regrounding.js";

describe("requestTextForRegrounding", () => {
  it("keeps plain string requests verbatim", () => {
    expect(requestTextForRegrounding({ role: "user", content: "Fix the login bug" })).toBe(
      "Fix the login bug",
    );
  });

  it("keeps the text of attachment messages and notes media by kind only", () => {
    const text = requestTextForRegrounding({
      role: "user",
      content: [
        { type: "text", text: "Match this mockup" },
        { type: "image", mediaType: "image/png", data: "AAAA" },
        { type: "text", text: "but keep the header" },
        { type: "image", mediaType: "image/png", data: "BBBB" },
      ],
    });
    expect(text).toBe("Match this mockup\nbut keep the header\n\n[Attached: 2 images]");
    expect(text).not.toContain("AAAA");
  });

  it("returns empty for a missing message", () => {
    expect(requestTextForRegrounding(undefined)).toBe("");
  });
});

describe("shouldReground", () => {
  it("fires once after a compaction occurs", () => {
    expect(shouldReground({ compactionOccurred: true, alreadyInjected: false })).toBe(true);
  });

  it("does not fire when no compaction has happened", () => {
    expect(shouldReground({ compactionOccurred: false, alreadyInjected: false })).toBe(false);
  });

  it("does not fire twice for the same compaction", () => {
    expect(shouldReground({ compactionOccurred: true, alreadyInjected: true })).toBe(false);
  });
});

describe("buildRegroundingMessage", () => {
  it("pins the original request verbatim", () => {
    const original = "Rename the qty field to quantity everywhere in inventory.ts";
    const message = buildRegroundingMessage(original);
    expect(message.role).toBe("user");
    expect(message.content).toContain("Re-ground");
    expect(message.content).toContain(original);
  });

  it("explains that context was compacted and warns against drift", () => {
    const content = buildRegroundingMessage("do the thing").content as string;
    expect(content).toContain("compacted");
    expect(content.toLowerCase()).toContain("drift");
  });

  it("does not instruct the model to narrate the note", () => {
    const content = buildRegroundingMessage("do the thing").content as string;
    expect(content.toLowerCase()).toContain("do not restate");
  });

  it("trims whitespace and tolerates an empty original request", () => {
    const message = buildRegroundingMessage("   ");
    expect(message.role).toBe("user");
    expect(message.content).toContain("Re-ground");
    expect(message.content).not.toContain('""');
  });
});

describe("askUserDecision", () => {
  it("keeps the user's answered choices", () => {
    expect(askUserDecision("The user answered:\n\nWhich scope?\n→ quick-wins")).toBe(
      "Which scope?\n→ quick-wins",
    );
  });

  it("keeps a typed reply that superseded the question", () => {
    const result =
      "The user skipped the question and replied with this message instead:\n\n" +
      "<user_message>\nonly fix agent.rs\n</user_message>\n\nTreat it as their answer and continue.";
    expect(askUserDecision(result)).toBe("only fix agent.rs");
  });

  it("ignores Ken's answers, dismissals and other results", () => {
    expect(askUserDecision("Autopilot Ken answered for the user:\n\nQ\n→ all")).toBeNull();
    expect(
      askUserDecision("The user did not answer (they dismissed the question). Do not ask again"),
    ).toBeNull();
    expect(askUserDecision("The user ignored the question and sent their own message")).toBeNull();
    expect(askUserDecision("some other text")).toBeNull();
  });
});

describe("recordUserDecision", () => {
  it("keeps the last five decisions, each capped", () => {
    let decisions: string[] = [];
    for (let i = 0; i < 7; i++)
      decisions = recordUserDecision(decisions, `The user answered: ${i}`);
    expect(decisions).toEqual(["2", "3", "4", "5", "6"]);
    const long = recordUserDecision([], `The user answered: ${"x".repeat(5_000)}`);
    expect(long[0]!.length).toBeLessThanOrEqual(1_501);
  });

  it("returns the same list when the result holds no user decision", () => {
    const decisions = ["a"];
    expect(recordUserDecision(decisions, "Autopilot Ken answered for the user: x")).toBe(decisions);
  });
});

describe("buildRegroundingMessage with user decisions", () => {
  it("lists the user's answers after the request as the current scope", () => {
    const content = buildRegroundingMessage("Do a big overview of our GG App", [
      "Which scope?\n→ quick-wins",
    ]).content as string;
    const requestAt = content.indexOf("Do a big overview");
    const scopeAt = content.indexOf("quick-wins");
    expect(requestAt).toBeGreaterThan(-1);
    expect(scopeAt).toBeGreaterThan(requestAt);
    expect(content).toContain("current scope");
    expect(content).toContain("not drift");
  });

  it("no longer tells the model to reject a narrowed version of the ask", () => {
    const withDecisions = buildRegroundingMessage("x", ["→ y"]).content as string;
    const without = buildRegroundingMessage("x").content as string;
    for (const content of [withDecisions, without]) {
      expect(content).not.toContain("narrowed version");
      expect(content).toContain("Next Step");
      expect(content).toContain("not to re-survey");
    }
  });

  it("still pins the request without decisions", () => {
    const content = buildRegroundingMessage("Fix the login bug").content as string;
    expect(content).toContain("Fix the login bug");
    expect(content).not.toContain("current scope");
  });
});
