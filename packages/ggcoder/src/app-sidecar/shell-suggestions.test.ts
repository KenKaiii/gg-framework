import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// os.homedir() reads USERPROFILE on Windows; point it at a temp dir instead.
let home = "";
vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home } };
});

const {
  loadShellHistory,
  mergeShellSuggestions,
  projectShellSuggestions,
  recordShellCommand,
  scriptCommands,
  SHELL_HISTORY_MAX,
} = await import("./shell-suggestions.js");

let project = "";
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-shell-home-"));
  project = await fs.mkdtemp(path.join(os.tmpdir(), "gg-shell-project-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(project, { recursive: true, force: true });
});

describe("shell history", () => {
  it("ranks a project's commands by how often they ran, then by recency", async () => {
    await recordShellCommand(project, "git status", 1);
    await recordShellCommand(project, "pnpm test", 2);
    await recordShellCommand(project, "pnpm test", 3);
    await recordShellCommand(project, "ls", 4);
    const history = await loadShellHistory(project);
    expect(history.map((h) => [h.command, h.count])).toEqual([
      ["pnpm test", 2],
      ["ls", 1],
      ["git status", 1],
    ]);
    // Another project has its own history.
    expect(await loadShellHistory(path.join(project, "other"))).toEqual([]);
  });

  it("keeps the most used when it grows past the cap", async () => {
    await recordShellCommand(project, "keep", 0);
    await recordShellCommand(project, "keep", 0);
    for (let i = 0; i < SHELL_HISTORY_MAX + 5; i++)
      await recordShellCommand(project, `c${i}`, i + 1);
    const history = await loadShellHistory(project);
    expect(history).toHaveLength(SHELL_HISTORY_MAX);
    expect(history[0]?.command).toBe("keep");
  }, 20_000);
});

describe("project suggestions", () => {
  it("offers git and package scripts, skipping servers and watchers", async () => {
    await fs.mkdir(path.join(project, ".git"));
    await fs.writeFile(path.join(project, "pnpm-lock.yaml"), "");
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify({
        scripts: { dev: "vite", lint: "eslint", test: "vitest", "build:watch": "x" },
      }),
    );
    const commands = (await projectShellSuggestions(project)).map((s) => s.command);
    expect(commands).toEqual([
      "git status",
      "git diff",
      "git log --oneline -10",
      "pnpm test",
      "pnpm lint",
    ]);
  });

  it("uses npm's own spelling for scripts", () => {
    expect(scriptCommands({ test: "x", build: "y" }, "npm")).toEqual(["npm test", "npm run build"]);
  });

  it("puts history first and never repeats a command", () => {
    const merged = mergeShellSuggestions(
      [{ command: "git status", count: 3, lastUsed: 1 }],
      [
        { command: "git status", count: 0, source: "git" },
        { command: "git diff", count: 0, source: "git" },
      ],
    );
    expect(merged).toEqual([
      { command: "git status", count: 3 },
      { command: "git diff", count: 0, source: "git" },
    ]);
  });
});
