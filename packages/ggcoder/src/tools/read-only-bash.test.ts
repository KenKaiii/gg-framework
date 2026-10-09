import { describe, expect, it } from "vitest";
import { isReadOnlyCommand, sleepOnlySeconds } from "./read-only-bash.js";

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
    ["git branch list", "git branch -a"],
    ["git branch list pattern", "git branch --list feat-*"],
    ["git tag list", "git tag -l"],
    ["git remote verbose", "git remote -v"],
    ["git remote get-url", "git remote get-url origin"],
    ["git remote show no-query", "git remote show -n origin"],
    ["git reflog", "git reflog -5"],
    ["find by name", "find . -name '*.ts' -maxdepth 2"],
    ["date read", "date"],
    ["date format read", "date '+%Y-%m-%d'"],
    ["sort read", "sort file.txt"],
    ["tree read", "tree src"],
    ["yq read", "yq '.a.b' config.yaml"],
    ["git log no-ext-diff", "git log --no-ext-diff"],
    ["git branch cluster listing", "git branch -av"],
    ["sort key read", "sort -k2,2 file.txt"],
    ["git tag numeric list", "git tag -n5"],
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
    ["awk exec", "awk 'BEGIN { system(\"rm -rf x\") }' f"],
    ["git branch delete", "git branch -D main"],
    ["git branch move", "git branch -m old new"],
    ["git branch create", "git branch feature-x"],
    ["git tag delete", "git tag -d v1"],
    ["git tag create", "git tag v1.0"],
    ["git remote set-url", "git remote set-url origin https://evil.example"],
    ["git remote add", "git remote add upstream ../x"],
    ["git remote show queries", "git remote show origin"],
    ["git reflog expire", "git reflog expire --expire=now --all"],
    ["git diff ext-diff", "git diff --ext-diff"],
    ["git show textconv", "git show --textconv HEAD"],
    ["date set clock", "date -s '12:00:00'"],
    ["find delete", "find . -name '*.ts' -delete"],
    ["find exec", "find . -type f -exec rm {} +"],
    ["rg preprocessor", "rg --pre ./x.sh TODO"],
    ["rg preprocessor =", "rg --pre=./x.sh TODO"],
    ["find fprint", "find . -fprintf /tmp/x '%p'"],
    ["sort output file", "sort -o out.txt in.txt"],
    ["tree output file", "tree -o tree.txt"],
    ["yq in place", "yq -i '.a = 1' config.yaml"],
    ["yq split", "yq '.[]' -s 'doc-~.yaml' in.yaml"],
    ["sed exec command", "sed '1e date' f"],
    ["sed exec flag", "sed 's/x/y/e' f"],
    ["sed compound exec", "sed 's/a/b/; e touch /tmp/pwn' f"],
    ["sed expression flag exec", "sed --expression='e date' f"],
    ["sed e as next token", "sed -e 'e date' f"],
    ["sed script from file", "sed -f transform.sed input.txt"],
    ["sed in-place with backup suffix", "sed -i.bak s/a/b/ f"],
    ["sed write command", "sed '2w /tmp/out' f"],
    ["sed attached value flag", "sed -es/a/b/ f"],
    ["git branch cluster delete", "git branch -df main"],
    ["sort cluster output", "sort -ro out.txt in.txt"],
    ["date cluster set", "date -su 12:00"],
  ];

  it.each(allowed)("allows %s", (_label, command) => {
    expect(isReadOnlyCommand(command)).toBe(true);
  });

  it.each(blocked)("blocks %s", (_label, command) => {
    expect(isReadOnlyCommand(command)).toBe(false);
  });
});

describe("sleepOnlySeconds", () => {
  it("totals bare sleeps, including chained and unit-suffixed ones", () => {
    expect(sleepOnlySeconds("sleep 30")).toBe(30);
    expect(sleepOnlySeconds("  sleep 0.5  ")).toBe(0.5);
    expect(sleepOnlySeconds("sleep 2; sleep 3")).toBe(5);
    expect(sleepOnlySeconds("sleep 1m")).toBe(60);
    expect(sleepOnlySeconds("sleep 2h")).toBe(7200);
  });

  it("leaves real work alone, even when it mentions sleep", () => {
    expect(sleepOnlySeconds("sleep 5; pnpm test")).toBeNull();
    expect(sleepOnlySeconds("pnpm build")).toBeNull();
    expect(sleepOnlySeconds("")).toBeNull();
    expect(sleepOnlySeconds("sleep")).toBeNull();
    expect(sleepOnlySeconds("sleep infinity")).toBeNull();
  });
});
