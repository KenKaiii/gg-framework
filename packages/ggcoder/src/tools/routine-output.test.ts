import { describe, expect, it } from "vitest";
import {
  compactGitLog,
  compactGitStatus,
  compactLsLong,
  compactPassingTestRun,
  compactRoutineOutput,
} from "./routine-output.js";

const GIT_LOG = [
  "commit e81d2a0fdfbead89b31fcf9978e5af048c828ddf (HEAD -> main, origin/main)",
  "Author: kenkaiii <ken@example.com>",
  "Date:   Sat Oct 24 01:23:14 2026 +0800",
  "",
  "    Update gg-app to v0.96.0",
  "",
  "    Body line one.",
  "",
  "    Body line two.",
  "",
  "commit b60217fd3c85b124833672ac44de72fb95d6257b",
  "Merge: 1111111 2222222",
  "Author: kenkaiii <ken@example.com>",
  "Date:   Fri Oct 2 19:19:53 2026 -0500",
  "",
  "    Version packages",
].join("\n");

describe("compactGitLog", () => {
  it("folds each commit header into one line and keeps every fact", () => {
    expect(compactGitLog(GIT_LOG)).toBe(
      [
        "e81d2a0fdfbe (HEAD -> main, origin/main) 2026-10-24 01:23:14 +0800 kenkaiii <ken@example.com>",
        "  Update gg-app to v0.96.0",
        "  Body line one.",
        "",
        "  Body line two.",
        "b60217fd3c85 2026-10-02 19:19:53 -0500 kenkaiii <ken@example.com> merge 1111111 2222222",
        "  Version packages",
      ].join("\n"),
    );
  });

  it("keeps a git show diff after the message intact", () => {
    const show = [
      "commit e81d2a0fdfbead89b31fcf9978e5af048c828ddf",
      "Author: a <a@x>",
      "Date:   Sat Oct 24 01:23:14 2026 +0800",
      "",
      "    Subject",
      "",
      "diff --git a/x b/x",
      "-old",
      "+new",
    ].join("\n");
    expect(compactGitLog(show)).toBe(
      [
        "e81d2a0fdfbe 2026-10-24 01:23:14 +0800 a <a@x>",
        "  Subject",
        "",
        "diff --git a/x b/x",
        "-old",
        "+new",
      ].join("\n"),
    );
  });

  it("leaves custom formats and non-matching text alone", () => {
    const oneline = "e81d2a0f Update gg-app\nb60217fd Version packages";
    expect(compactGitLog(oneline)).toBe(oneline);
    const noAuthor = "commit e81d2a0fdfbead89b31fcf9978e5af048c828ddf\nsomething else";
    expect(compactGitLog(noAuthor)).toBe(noAuthor);
  });
});

describe("compactGitStatus", () => {
  it("drops only the git hint lines", () => {
    const status = [
      "On branch main",
      "Your branch is up to date with 'origin/main'.",
      "",
      "Changes not staged for commit:",
      '  (use "git add <file>..." to update what will be committed)',
      '  (use "git restore <file>..." to discard changes in working directory)',
      "\tmodified:   packages/ggcoder/src/tools/code-nav.ts",
      "",
      "Untracked files:",
      '  (use "git add <file>..." to include in what will be committed)',
      "\tnotes.md",
      "",
      'no changes added to commit (use "git add" and/or "git commit -a")',
    ].join("\n");
    expect(compactGitStatus(status)).toBe(
      [
        "On branch main",
        "Your branch is up to date with 'origin/main'.",
        "",
        "Changes not staged for commit:",
        "\tmodified:   packages/ggcoder/src/tools/code-nav.ts",
        "",
        "Untracked files:",
        "\tnotes.md",
        "",
        'no changes added to commit (use "git add" and/or "git commit -a")',
      ].join("\n"),
    );
  });

  it("does not touch hint-shaped lines outside git status output", () => {
    const text = '  (use "git add <file>..." to update what will be committed)';
    expect(compactGitStatus(text)).toBe(text);
  });
});

describe("compactLsLong", () => {
  const entry = (perm: string, name: string, size = "160") =>
    `${perm}   5 kenkai  staff  ${size} Oct 24 09:21 ${name}`;

  it("states a shared owner/group once and keeps perms, size, date and name", () => {
    const ls = [
      "total 2456",
      entry("drwxr-xr-x@", "."),
      entry("drwxr-xr-x@", ".."),
      entry("-rw-r--r--@", "a.ts", "10632"),
      entry("-rw-r--r--@", "b.ts", "4.5K"),
      entry("-rw-r--r--@", "c.ts", "2"),
    ].join("\n");
    expect(compactLsLong(ls)).toBe(
      [
        "total 2456 (owner kenkai, group staff for all entries; link counts omitted)",
        "drwxr-xr-x@ 160 Oct 24 09:21 .",
        "drwxr-xr-x@ 160 Oct 24 09:21 ..",
        "-rw-r--r--@ 10632 Oct 24 09:21 a.ts",
        "-rw-r--r--@ 4.5K Oct 24 09:21 b.ts",
        "-rw-r--r--@ 2 Oct 24 09:21 c.ts",
      ].join("\n"),
    );
  });

  it("leaves mixed owners, short listings and unparsed lines alone", () => {
    const mixed = ["total 8", ...["a", "b", "c", "d"].map((n) => entry("-rw-r--r--", n))];
    mixed.push("-rw-r--r--   1 root  wheel  1 Oct 24 09:21 e");
    expect(compactLsLong(mixed.join("\n"))).toBe(mixed.join("\n"));
    const short = ["total 8", entry("-rw-r--r--", "a"), entry("-rw-r--r--", "b")].join("\n");
    expect(compactLsLong(short)).toBe(short);
    // `ls -lo` has no group column: the size would be read as the group.
    const noGroup = [
      "total 8",
      ...["a", "b", "c", "d", "e"].map((n) => `-rw-r--r--  1 kenkai  10632 Oct 24 09:21 ${n}`),
    ].join("\n");
    expect(compactLsLong(noGroup)).toBe(noGroup);
  });
});

describe("compactPassingTestRun", () => {
  const green = [
    " RUN  v4.1.4 /repo/packages/ggcoder",
    "",
    " ✓ src/tools/truncate.test.ts (12 tests) 3ms",
    " ✓ src/tools/edit-diff.test.ts (54 tests) 550ms",
    "     ✓ bounds empty and normalization-empty occurrence searches  542ms",
    " ✓ src/tools/grep.test.ts (45 tests | 2 skipped) 551ms",
    " ✓ src/tools/one.test.ts (1 test) 1ms",
    "",
    " Test Files  4 passed (4)",
    "      Tests  110 passed | 2 skipped (112)",
  ].join("\n");

  it("replaces per-file pass lines with a count and keeps test-level, skip and summary lines", () => {
    expect(compactPassingTestRun(green)).toBe(
      [
        " RUN  v4.1.4 /repo/packages/ggcoder",
        "",
        "[3 passing test files not listed — all passed; summary below]",
        "     ✓ bounds empty and normalization-empty occurrence searches  542ms",
        " ✓ src/tools/grep.test.ts (45 tests | 2 skipped) 551ms",
        "",
        " Test Files  4 passed (4)",
        "      Tests  110 passed | 2 skipped (112)",
      ].join("\n"),
    );
  });

  it("never touches a run with failures", () => {
    const red = [
      " ✓ src/a.test.ts (3 tests) 1ms",
      " ✓ src/b.test.ts (3 tests) 1ms",
      " ❯ src/c.test.ts (12 tests | 6 failed) 6ms",
      "     × returns content unchanged when within limits 3ms",
      " Test Files  1 failed | 2 passed (3)",
    ].join("\n");
    expect(compactPassingTestRun(red)).toBe(red);
  });

  it("collapses jest PASS lines in a green run", () => {
    const jest = [
      "PASS src/a.test.ts",
      "PASS src/b.test.ts (5.2 s)",
      "",
      "Test Suites: 2 passed, 2 total",
      "Tests:       9 passed, 9 total",
    ].join("\n");
    expect(compactPassingTestRun(jest)).toBe(
      [
        "[2 passing test files not listed — all passed; summary below]",
        "",
        "Test Suites: 2 passed, 2 total",
        "Tests:       9 passed, 9 total",
      ].join("\n"),
    );
  });
});

describe("compactRoutineOutput", () => {
  it("passes ordinary output through unchanged", () => {
    for (const raw of ["", "ok", "tests failed", "src/a.ts:1:export function x() {}"]) {
      expect(compactRoutineOutput(raw)).toBe(raw);
    }
  });
});
