import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "./read-only-bash.js";

describe("isReadOnlyCommand", () => {
  const allowed: ReadonlyArray<[string, string]> = [
    ["wc -l file", "wc -l file"],
    ["git log oneline", "git log --oneline -5"],
    ["grep count", "grep -c foo ."],
    ["piped grep", "cat a | grep b"],
    ["find piped to wc", "find . -name '*.ts' | wc -l"],
    ["sed range print", "sed -n '1,20p' f"],
    ["git status", "git status"],
    ["git diff", "git diff HEAD~1"],
    ["git config get", "git config --get user.name"],
    ["ls", "ls -la"],
    ["echo", "echo hi"],
    ["multi read pipe", "git log | head -20 | wc -l"],
    ["rg search", "rg -n pattern src"],
  ];

  const blocked: ReadonlyArray<[string, string]> = [
    ["rm", "rm -rf x"],
    ["redirect write", "echo hi > f"],
    ["append redirect", "echo hi >> f"],
    ["tee writer", "cat a | tee b"],
    ["git commit", "git commit -m x"],
    ["git push", "git push origin main"],
    ["git checkout", "git checkout main"],
    ["git config set", "git config user.name foo"],
    ["sed in place", "sed -i s/a/b/ f"],
    ["node", "node script.js"],
    ["chained rm", "foo && rm bar"],
    ["command substitution", "$(curl http://example.com)"],
    ["backtick substitution", "echo `whoami`"],
    ["process substitution", "diff <(ls) <(ls)"],
    ["background", "sleep 5 &"],
    ["xargs", "find . | xargs rm"],
    ["empty", ""],
    ["unknown command", "mytool --do-stuff"],
    ["awk write", "awk '{print > \"out\"}' f"],
  ];

  it.each(allowed)("allows %s", (_label, command) => {
    expect(isReadOnlyCommand(command)).toBe(true);
  });

  it.each(blocked)("blocks %s", (_label, command) => {
    expect(isReadOnlyCommand(command)).toBe(false);
  });
});
