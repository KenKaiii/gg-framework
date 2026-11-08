import { describe, expect, it } from "vitest";
import { planLanguagePackUpdate } from "./language-pack-update.js";

const cwd = process.cwd();
const ts = new Set(["typescript"] as const);

describe("planLanguagePackUpdate", () => {
  it("does nothing when no language is new", () => {
    expect(
      planLanguagePackUpdate({ added: new Set(), cwd, hasReply: true, betweenTurns: true }),
    ).toEqual({
      kind: "none",
    });
  });

  it("rebuilds the system prompt only before anything is cached", () => {
    expect(
      planLanguagePackUpdate({ added: ts, cwd, hasReply: false, betweenTurns: false }).kind,
    ).toBe("rebuild");
  });

  it("never rewrites the cached prompt mid-run: a tool scaffolding package.json defers", () => {
    expect(
      planLanguagePackUpdate({ added: ts, cwd, hasReply: true, betweenTurns: false }).kind,
    ).toBe("defer");
  });

  it("appends a hidden update message between turns", () => {
    const plan = planLanguagePackUpdate({ added: ts, cwd, hasReply: true, betweenTurns: true });
    expect(plan.kind).toBe("append");
    if (plan.kind !== "append") return;
    expect(plan.message.role).toBe("user");
    expect(String(plan.message.content)).toContain("new languages are now in use");
  });
});
