import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isCatastrophicCommand, resolveWriteGuard } from "./workspace-guard.js";

const cwd = path.join(os.tmpdir(), "guard-test-workspace");

describe("resolveWriteGuard", () => {
  it("allows paths under the workspace cwd", () => {
    expect(resolveWriteGuard(cwd, path.join(cwd, "src", "a.ts")).allowed).toBe(true);
    expect(resolveWriteGuard(cwd, cwd).allowed).toBe(true);
  });

  it("allows paths under the OS temp dir", () => {
    const target = path.join(os.tmpdir(), "scratch", "notes.md");
    expect(resolveWriteGuard("/somewhere/else", target).allowed).toBe(true);
  });

  it("allows paths under the agent's own ~/.gg state dir", () => {
    const target = path.join(os.homedir(), ".gg", "plans", "plan.md");
    expect(resolveWriteGuard(cwd, target).allowed).toBe(true);
  });

  it("blocks paths outside all allowed roots with an instructive reason", () => {
    const target = path.join(os.homedir(), "Documents", "outside.txt");
    const result = resolveWriteGuard(cwd, target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the workspace");
    expect(result.reason).toContain("allowOutsideWorkspaceWrites");
  });

  it("does not treat sibling directories with a shared prefix as inside", () => {
    const result = resolveWriteGuard(cwd, `${cwd}-evil/file.txt`);
    // `${cwd}-evil` shares the cwd string prefix but is a different directory.
    // It IS still under tmpdir here, so use a home-based pair instead.
    const home = path.join(os.homedir(), "project");
    expect(resolveWriteGuard(home, `${home}-evil/file.txt`).allowed).toBe(false);
    expect(result.allowed).toBe(true); // tmpdir root still allows it
  });

  it("allows everything when allowOutsideWorkspaceWrites is enabled", () => {
    const target = path.join(os.homedir(), "Documents", "outside.txt");
    expect(resolveWriteGuard(cwd, target, { allowOutsideWorkspaceWrites: true }).allowed).toBe(
      true,
    );
  });
});

describe("isCatastrophicCommand", () => {
  it.each([
    "rm -rf /",
    "rm -fr /",
    "rm -r -f /",
    "rm --recursive --force /",
    "rm -rf ~",
    "rm -rf $HOME",
    'rm -rf "$HOME"',
    "sudo rm -rf /",
    `rm -rf ${os.homedir()}`,
  ])("blocks %s", (command) => {
    const result = isCatastrophicCommand(command, cwd);
    expect(result).not.toBeNull();
    expect(result).toContain("user confirmation");
  });

  it("blocks recursive force-remove of the workspace root itself", () => {
    expect(isCatastrophicCommand("rm -rf .", cwd)).not.toBeNull();
    expect(isCatastrophicCommand(`rm -rf ${cwd}`, cwd)).not.toBeNull();
  });

  it("blocks Windows rd /s /q on a bare drive root", () => {
    expect(isCatastrophicCommand("rd /s /q C:\\", cwd)).not.toBeNull();
    expect(isCatastrophicCommand("rmdir /s /q C:\\", cwd)).not.toBeNull();
  });

  it("blocks a chained catastrophic command", () => {
    expect(isCatastrophicCommand("echo done && rm -rf /", cwd)).not.toBeNull();
  });

  it("blocks git push --force --mirror", () => {
    expect(isCatastrophicCommand("git push --force --mirror origin", cwd)).not.toBeNull();
    expect(isCatastrophicCommand("git push --mirror -f origin", cwd)).not.toBeNull();
  });

  it.each([
    "rm -rf node_modules",
    "rm -rf ./dist",
    "rm -rf /tmp/scratch-dir",
    "rm -rf build coverage",
    "rm file.txt",
    "rm -r src/old",
    "git reset --hard HEAD~1",
    "git push --force origin feature-branch",
    "git push --mirror backup", // mirror without force
    "rd /s /q build",
    "ls -la /",
  ])("allows %s", (command) => {
    expect(isCatastrophicCommand(command, cwd)).toBeNull();
  });
});
