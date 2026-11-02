import { describe, expect, it } from "vitest";
import {
  filterShellSuggestions,
  shellEnterPicks,
  shellSuggestionNote,
  SHELL_MENU_MAX,
} from "./shell-menu";

const list = [
  { command: "pnpm test", count: 9 },
  { command: "git status", count: 4 },
  { command: "pnpm lint:git", count: 2 },
  { command: "git diff", count: 0, source: "git" },
];

describe("filterShellSuggestions", () => {
  it("shows everything, most used first, for a bare !", () => {
    expect(filterShellSuggestions(list, "").map((s) => s.command)).toEqual(
      list.map((s) => s.command),
    );
    const many = Array.from({ length: 20 }, (_, i) => ({ command: `c${i}`, count: 1 }));
    expect(filterShellSuggestions(many, "")).toHaveLength(SHELL_MENU_MAX);
  });

  it("puts commands that start with the query ahead of ones that only contain it", () => {
    expect(filterShellSuggestions(list, "git").map((s) => s.command)).toEqual([
      "git status",
      "git diff",
      "pnpm lint:git",
    ]);
  });

  it("drops the command already typed in full", () => {
    expect(filterShellSuggestions(list, "git diff")).toEqual([]);
  });
});

describe("shellSuggestionNote", () => {
  it("says how often it ran, or where it comes from", () => {
    expect(shellSuggestionNote({ command: "a", count: 1 })).toBe("ran once");
    expect(shellSuggestionNote({ command: "a", count: 4 })).toBe("ran 4 times");
    expect(shellSuggestionNote({ command: "a", count: 0, source: "package.json" })).toBe(
      "from package.json",
    );
  });
});

describe("shellEnterPicks", () => {
  it("runs a typed command unless the user picked a row with the arrows", () => {
    expect(shellEnterPicks("!", null)).toBe(true);
    expect(shellEnterPicks("!ls", null)).toBe(false);
    expect(shellEnterPicks("!ls", "!ls")).toBe(true);
    expect(shellEnterPicks("!ls ", "!ls")).toBe(false);
  });
});
