import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadStreamRules } from "./stream-rules.js";

let root: string;
let home: string;
let cwd: string;

async function writeRule(base: string, file: string, content: string): Promise<void> {
  const dir = path.join(base, ".gg", "rules");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), content, "utf8");
}

function rule(fields: Record<string, string>, body = "Follow the rule."): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-stream-rules-"));
  home = path.join(root, "home");
  cwd = path.join(root, "project");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("loadStreamRules", () => {
  it("returns [] when no rule dirs exist", async () => {
    expect(await loadStreamRules(cwd, home)).toEqual([]);
  });

  it("loads a valid rule with scope, tools and trimmed reminder", async () => {
    await writeRule(
      cwd,
      "no-log.md",
      rule(
        { name: "no-log", trigger: "console\\.log\\(", scope: "tool", tools: "[edit, write]" },
        "\n  Use the logger.  \n",
      ),
    );
    const [loaded, ...rest] = await loadStreamRules(cwd, home);
    expect(rest).toHaveLength(0);
    expect(loaded).toMatchObject({
      name: "no-log",
      scope: "tool",
      reminder: "Use the logger.",
      tools: ["edit", "write"],
    });
    expect(loaded?.pattern.test("console.log(x)")).toBe(true);
    expect(loaded?.pattern.test("console.error(x)")).toBe(false);
  });

  it("defaults scope to both and caps the reminder", async () => {
    await writeRule(home, "a.md", rule({ name: "a", trigger: "TODO" }, "x".repeat(1500)));
    const [loaded] = await loadStreamRules(cwd, home);
    expect(loaded?.scope).toBe("both");
    expect(loaded?.tools).toBeUndefined();
    expect(loaded?.reminder).toHaveLength(1000);
  });

  it("accepts /source/flags triggers", async () => {
    await writeRule(home, "a.md", rule({ name: "a", trigger: "/todo/i" }));
    const [loaded] = await loadStreamRules(cwd, home);
    expect(loaded?.pattern.test("TODO")).toBe(true);
  });

  it("skips invalid regex, missing fields and bad scope without throwing", async () => {
    await writeRule(cwd, "bad-regex.md", rule({ name: "bad", trigger: "foo(" }));
    await writeRule(cwd, "no-name.md", rule({ trigger: "x" }));
    await writeRule(cwd, "no-trigger.md", rule({ name: "nt" }));
    await writeRule(cwd, "bad-scope.md", rule({ name: "bs", trigger: "x", scope: "thinking" }));
    await writeRule(cwd, "ok.md", rule({ name: "ok", trigger: "x" }));
    const rules = await loadStreamRules(cwd, home);
    expect(rules.map((r) => r.name)).toEqual(["ok"]);
  });

  it("rejects dangerous project regexes", async () => {
    await writeRule(cwd, "nested.md", rule({ name: "nested", trigger: "(a+)+$" }));
    await writeRule(cwd, "long.md", rule({ name: "long", trigger: "a".repeat(301) }));
    await writeRule(cwd, "ok.md", rule({ name: "ok", trigger: "(ab)+" }));
    const rules = await loadStreamRules(cwd, home);
    expect(rules.map((r) => r.name)).toEqual(["ok"]);
  });

  it("lets project rules override user rules with the same name", async () => {
    await writeRule(home, "shared.md", rule({ name: "shared", trigger: "user" }, "user reminder"));
    await writeRule(home, "only-user.md", rule({ name: "only-user", trigger: "u" }));
    await writeRule(
      cwd,
      "shared.md",
      rule({ name: "shared", trigger: "project" }, "project reminder"),
    );
    const rules = await loadStreamRules(cwd, home);
    const shared = rules.find((r) => r.name === "shared");
    expect(rules).toHaveLength(2);
    expect(shared?.reminder).toBe("project reminder");
    expect(shared?.pattern.source).toBe("project");
  });

  it("caps the number of rules at 50", async () => {
    for (let i = 0; i < 55; i++) {
      await writeRule(
        home,
        `r${String(i).padStart(2, "0")}.md`,
        rule({ name: `r${i}`, trigger: "x" }),
      );
    }
    expect(await loadStreamRules(cwd, home)).toHaveLength(50);
  });
});
