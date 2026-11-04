import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDestructiveGit, findDestructiveGitCommands } from "./destructive-git-guard.js";
import { ProcessManager } from "./process-manager.js";
import { createBashTool } from "../tools/bash.js";
import { createTaskSendTool } from "../tools/task-send.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** A repo with one commit containing a.ts and b.ts. */
function makeRepo(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "a.ts"), "a\n");
  fs.writeFileSync(path.join(dir, "b.ts"), "b\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "c.ts"), "c\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("findDestructiveGitCommands (parse)", () => {
  const cwd = path.resolve("/work/repo");
  const kindOf = (command: string): string[] =>
    findDestructiveGitCommands(command, cwd).map((m) => m.kind);

  it.each([
    ["git reset --hard", "reset-hard"],
    ["git reset --hard HEAD~1", "reset-hard"],
    ["git reset HEAD --hard", "reset-hard"],
    ["git reset --har", "reset-hard"],
    ["git checkout -- a.ts", "checkout-paths"],
    ["git checkout .", "checkout-paths"],
    ["git checkout HEAD -- src/", "checkout-paths"],
    ["git checkout -f main", "checkout-paths"],
    ["git restore a.ts", "restore-worktree"],
    ["git restore --worktree a.ts", "restore-worktree"],
    ["git restore --staged --worktree a.ts", "restore-worktree"],
    ["git restore -SW .", "restore-worktree"],
    ["git clean -f", "clean"],
    ["git clean -fdx", "clean"],
    ["git clean --force -d", "clean"],
    ["git stash drop", "stash-drop"],
    ["git stash drop stash@{2}", "stash-drop"],
    ["git stash clear", "stash-clear"],
    ["git branch -D feature", "branch-force-delete"],
    ["git branch --delete --force feature", "branch-force-delete"],
    ["git branch -df feature", "branch-force-delete"],
    ["git push --force", "force-push"],
    ["git push -f origin main", "force-push"],
    ["git push -uf origin main", "force-push"],
    ["git push origin +main", "force-push"],
    ["git push --force-with-lease --force origin main", "force-push"],
    // wrappers and hiding places
    ["npm test && git reset --hard", "reset-hard"],
    ["echo hi; git reset --hard", "reset-hard"],
    ["false || git reset --hard", "reset-hard"],
    ["git status | git reset --hard", "reset-hard"],
    ["(cd sub && git reset --hard)", "reset-hard"],
    ["{ git reset --hard; }", "reset-hard"],
    ["if true; then git reset --hard; fi", "reset-hard"],
    ["for f in a b; do git checkout -- $f; done", "checkout-paths"],
    ["while true; do git clean -fd; break; done", "clean"],
    ['bash -c "git reset --hard"', "reset-hard"],
    ["sh -c 'git reset --hard'", "reset-hard"],
    ["bash -lc 'cd x && git reset --hard'", "reset-hard"],
    ["sh -c \"bash -c 'git reset --hard'\"", "reset-hard"],
    ["timeout 10 git reset --hard", "reset-hard"],
    ["nohup git reset --hard > /dev/null 2>&1", "reset-hard"],
    ["env X=1 Y=2 git reset --hard", "reset-hard"],
    ["X=1 git reset --hard", "reset-hard"],
    ["sudo git reset --hard", "reset-hard"],
    ["sudo -u bob timeout 5 nice -n 5 git reset --hard", "reset-hard"],
    ["echo a.ts | xargs git checkout --", "checkout-paths"],
    ["git -C ../other reset --hard", "reset-hard"],
    ["git -c core.pager=cat --no-pager reset --hard", "reset-hard"],
    ["/usr/bin/git reset --hard", "reset-hard"],
    ['echo "$(git reset --hard)"', "reset-hard"],
    ["echo `git stash clear`", "stash-clear"],
    ['eval "git reset --hard"', "reset-hard"],
    ["bash <<EOF\ngit reset --hard\nEOF", "reset-hard"],
    ["git reset \\\n  --hard", "reset-hard"],
  ])("flags %j", (command, kind) => {
    expect(kindOf(command)).toContain(kind);
  });

  it.each([
    "git reset --soft HEAD~1",
    "git reset HEAD a.ts",
    "git reset",
    "git checkout -b x",
    "git checkout -B x origin/x",
    "git checkout main",
    "git switch main",
    "git restore --staged a.ts",
    "git restore -S a.ts",
    "git clean -n",
    "git clean -fn",
    "git clean -d",
    "git stash",
    "git stash pop",
    "git stash list",
    "git branch -d feature",
    "git branch -D -r origin/feature",
    "git push",
    "git push --force-with-lease",
    "git push --force-with-lease=main:abc123 origin main",
    "git push --force-if-includes --force-with-lease origin main",
    "git status --porcelain",
    "git rebase -i HEAD~3",
    "git commit --amend --no-edit",
    'echo "git reset --hard"',
    "echo 'git push --force'",
    "grep 'reset --hard' file",
    'grep -r "git clean -fdx" docs',
    "printf '%s\\n' 'git checkout -- .'",
    "cat <<EOF > notes.md\ngit reset --hard\nEOF",
    "# git reset --hard",
    "sudo echo git reset --hard",
    'git commit -m "undo with git reset --hard"',
    "ls -la",
  ])("allows lookalike %j", (command) => {
    expect(findDestructiveGitCommands(command, cwd)).toEqual([]);
  });

  it("resolves the target directory through cd and git -C", () => {
    expect(findDestructiveGitCommands("cd pkg && git reset --hard", cwd)[0]?.dir).toBe(
      path.join(cwd, "pkg"),
    );
    expect(findDestructiveGitCommands("git -C ../other reset --hard", cwd)[0]?.dir).toBe(
      path.resolve(cwd, "../other"),
    );
    expect(findDestructiveGitCommands("git -C a -C b clean -f", cwd)[0]?.dir).toBe(
      path.join(cwd, "a", "b"),
    );
  });

  it("captures pathspecs", () => {
    expect(findDestructiveGitCommands("git checkout -- a.ts b.ts", cwd)[0]?.pathspecs).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(
      findDestructiveGitCommands("git restore --source HEAD~2 src/x.ts", cwd)[0]?.pathspecs,
    ).toEqual(["src/x.ts"]);
  });

  it("widens a pathspec holding an unexpanded variable to the whole tree", () => {
    // `$f` matches no file literally, so a narrowed check would pass a dirty tree.
    expect(
      findDestructiveGitCommands("for f in .; do git checkout -- $f; done", cwd)[0]?.pathspecs,
    ).toEqual([]);
  });
});

describe("checkDestructiveGit (real repos)", () => {
  let root = "";
  let dirty = "";
  let clean = "";
  let untracked = "";

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gg-git-guard-")));
    clean = makeRepo(root, "clean");
    dirty = makeRepo(root, "dirty");
    fs.writeFileSync(path.join(dirty, "a.ts"), "changed\n");
    fs.writeFileSync(path.join(dirty, "b.ts"), "changed\n");
    fs.rmSync(path.join(dirty, "src", "c.ts"));
    untracked = makeRepo(root, "untracked");
    fs.writeFileSync(path.join(untracked, "new.ts"), "new\n");
    fs.writeFileSync(path.join(untracked, ".gitignore"), "dist/\n");
    git(untracked, "add", ".gitignore");
    git(untracked, "commit", "-q", "-m", "ignore");
    fs.mkdirSync(path.join(untracked, "dist"));
    fs.writeFileSync(path.join(untracked, "dist", "out.js"), "x\n");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const check = (command: string, cwd: string): Promise<string | null> =>
    checkDestructiveGit(command, { cwd });

  it.each([
    "git reset --hard",
    "git reset HEAD --hard",
    "git checkout -- a.ts",
    "git checkout .",
    "git restore b.ts",
    "npm run build && git reset --hard",
    "bash -c 'git stash list; git reset --hard'",
    "timeout 5 env A=1 git reset --hard",
  ])("blocks %j on a dirty tree and says what would be lost", async (command) => {
    const reason = await check(command, dirty);
    expect(reason).not.toBeNull();
    expect(reason).toContain("git stash push -u");
    expect(reason).toContain("ask_user");
  });

  it("lists the files that would be lost", async () => {
    const reason = await check("git reset --hard", dirty);
    expect(reason).toContain("3 changed files (2 modified, 1 deleted)");
    expect(reason).toContain("a.ts");
    expect(reason).toContain("src/c.ts");
  });

  it("limits checkout/restore to the named paths", async () => {
    // src/ has only a deletion; a.ts untouched by this pathspec.
    expect(await check("git checkout -- src/", dirty)).toContain("1 changed file");
    expect(await check("git restore b.ts", dirty)).not.toContain("a.ts");
  });

  it("follows cd and git -C to the real repo", async () => {
    expect(await check("cd dirty && git reset --hard", root)).not.toBeNull();
    expect(await check("git -C dirty reset --hard", root)).not.toBeNull();
    expect(await check("cd clean && git reset --hard", root)).toBeNull();
  });

  it("uses resolveCwd for a shell whose directory moved", async () => {
    const reason = await checkDestructiveGit("git reset --hard", {
      cwd: clean,
      resolveCwd: () => Promise.resolve(dirty),
    });
    expect(reason).not.toBeNull();
  });

  it.each([
    "git reset --hard",
    "git reset --hard HEAD",
    "git checkout -- .",
    "git restore .",
    "git clean -fd",
    "git stash drop",
    "git stash clear",
  ])("allows %j on a clean tree", async (command) => {
    expect(await check(command, clean)).toBeNull();
  });

  it("does not count untracked files for reset --hard", async () => {
    expect(await check("git reset --hard", untracked)).toBeNull();
  });

  it("blocks git clean -f when untracked files exist", async () => {
    const reason = await check("git clean -f", untracked);
    expect(reason).toContain("new.ts");
    expect(reason).not.toContain("dist/");
    expect(reason).toContain("git clean -n");
  });

  it("counts ignored files only for clean -x / -X", async () => {
    expect(await check("git clean -fdX", untracked)).toContain("dist/");
    expect(await check("git clean -fdX", untracked)).not.toContain("new.ts");
    expect(await check("git clean -fdx", untracked)).toContain("git stash push -a");
  });

  it("allows checkout of a branch whose name is also a path", async () => {
    git(dirty, "branch", "src");
    try {
      expect(await check("git checkout src", dirty)).toBeNull();
    } finally {
      git(dirty, "branch", "-D", "src");
    }
  });

  it("blocks stash drop/clear only when stashes exist", async () => {
    const repo = makeRepo(root, "stashes");
    fs.writeFileSync(path.join(repo, "a.ts"), "wip\n");
    git(repo, "stash", "push", "-q", "-m", "wip");
    expect(await check("git stash drop", repo)).toContain("stash@{0}");
    expect(await check("git stash clear", repo)).toContain("all 1 stash entry");
  });

  it("blocks branch -D only when the branch has unique commits", async () => {
    const repo = makeRepo(root, "branches");
    git(repo, "branch", "merged");
    git(repo, "checkout", "-q", "-b", "unique");
    fs.writeFileSync(path.join(repo, "u.ts"), "u\n");
    git(repo, "add", "u.ts");
    git(repo, "commit", "-q", "-m", "unique work");
    git(repo, "checkout", "-q", "main");
    expect(await check("git branch -D merged", repo)).toBeNull();
    expect(await check("git branch -D missing", repo)).toBeNull();
    const reason = await check("git branch -D unique", repo);
    expect(reason).toContain("unique (1 commit)");
    expect(reason).toContain("git branch -d");
  });

  it("always blocks a plain force push, never --force-with-lease", async () => {
    expect(await check("git push --force origin main", clean)).toContain("--force-with-lease");
    expect(await check("git push -f", root)).not.toBeNull();
    expect(await check("git push --force-with-lease origin main", clean)).toBeNull();
  });

  it("fails open outside a repo and for a directory that does not exist", async () => {
    expect(await check("git reset --hard", root)).toBeNull();
    expect(await check("git reset --hard", path.join(root, "nope"))).toBeNull();
  });

  it("allows harmless commands without touching git", async () => {
    expect(await check("echo 'git reset --hard'", dirty)).toBeNull();
    expect(await check("git reset --soft HEAD", dirty)).toBeNull();
    expect(await check("git restore --staged a.ts", dirty)).toBeNull();
  });

  describe("tool wiring", () => {
    const ctx = (id: string): { signal: AbortSignal; toolCallId: string } => ({
      signal: new AbortController().signal,
      toolCallId: id,
    });

    it.each([
      ["foreground", {}],
      ["background", { run_in_background: true }],
      ["persistent", { persist: true }],
    ])("bash %s blocks a reset --hard that would lose work", async (_label, extra) => {
      const tool = createBashTool(dirty, new ProcessManager());
      const result = await tool.execute({ command: "git reset --hard", ...extra }, ctx("g1"));
      expect(String(result)).toMatch(/^Error: Blocked .*would permanently discard/s);
      expect(fs.readFileSync(path.join(dirty, "a.ts"), "utf8")).toBe("changed\n");
    });

    it("bash runs the same command on a clean tree", async () => {
      const tool = createBashTool(clean, new ProcessManager());
      const result = await tool.execute({ command: "git reset --hard" }, ctx("g2"));
      expect(String(result)).toContain("Exit code: 0");
    });

    it.skipIf(process.platform === "win32")(
      "persistent shell is checked in the directory it cd'd to",
      async () => {
        const tool = createBashTool(root, new ProcessManager());
        await tool.execute({ command: "cd dirty", persist: true }, ctx("g3"));
        const result = await tool.execute(
          { command: "git reset --hard", persist: true },
          ctx("g4"),
        );
        expect(String(result)).toMatch(/^Error: /);
        expect(fs.readFileSync(path.join(dirty, "a.ts"), "utf8")).toBe("changed\n");
      },
    );

    it("task_send refuses destructive input to a background shell", async () => {
      const pm = new ProcessManager();
      const tool = createTaskSendTool(pm, dirty);
      const result = await tool.execute({ id: "nope", input: "git checkout -- ." }, ctx("g5"));
      expect(String(result)).toMatch(/^Error: input not sent\./);
      const harmless = await tool.execute({ id: "nope", input: "y" }, ctx("g6"));
      expect(String(harmless)).toContain("No background process");
    });
  });
});
