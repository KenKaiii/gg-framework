import { describe, expect, it } from "vitest";
import { changedSinceCheck } from "./checklist-git.js";

const CHECKED = "2026-10-05T09:00:00.000Z";

describe("changedSinceCheck", () => {
  it.each([
    [
      "same commit, clean then and now",
      "abc1234",
      false,
      { commit: "abc1234", uncommittedChanges: false },
      false,
    ],
    ["new commit", "abc1234", false, { commit: "def5678", uncommittedChanges: false }, true],
    [
      "clean when checked, edited since",
      "abc1234",
      false,
      { commit: "abc1234", uncommittedChanges: true },
      true,
    ],
    [
      "already dirty when checked",
      "abc1234",
      true,
      { commit: "abc1234", uncommittedChanges: true },
      false,
    ],
    ["no repository", null, false, { commit: null, uncommittedChanges: false }, false],
    ["live state unknown", "abc1234", false, null, false],
  ] as const)("%s", (_name, commit, uncommittedChanges, current, expected) => {
    expect(changedSinceCheck({ checkedAt: CHECKED, commit, uncommittedChanges }, current)).toBe(
      expected,
    );
  });

  it("never flags an item that was never recorded", () => {
    expect(
      changedSinceCheck(
        { checkedAt: null, commit: null, uncommittedChanges: false },
        { commit: "abc1234", uncommittedChanges: true },
      ),
    ).toBe(false);
  });
});
