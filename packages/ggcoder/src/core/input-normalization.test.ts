import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillFile } from "./skills.js";
import { parseAgentFile } from "./agents.js";
import { loadCustomCommands } from "./custom-commands.js";
import { stripBom } from "../utils/text.js";
import { createSkillTool } from "../tools/skill.js";

const BOM = "\uFEFF";

describe("stripBom", () => {
  it("removes a single leading BOM and nothing else", () => {
    expect(stripBom(`${BOM}hello`)).toBe("hello");
    expect(stripBom("hello")).toBe("hello");
    expect(stripBom("")).toBe("");
    // Only the leading BOM is stripped; interior ones are content.
    expect(stripBom(`a${BOM}b`)).toBe(`a${BOM}b`);
  });
});

describe("BOM-tolerant instruction parsing", () => {
  const frontmatter = "---\nname: Fancy-Skill\ndescription: Does fancy things\n---\n\nBody text.";

  it("parses SKILL.md frontmatter behind a BOM", () => {
    const skill = parseSkillFile(`${BOM}${frontmatter}`, "test");

    expect(skill.name).toBe("Fancy-Skill");
    expect(skill.description).toBe("Does fancy things");
    expect(skill.content).toBe("Body text.");
  });

  it("parses agent.md frontmatter behind a BOM", () => {
    const raw = `${BOM}---\nname: scout\ndescription: Recon\ntools: read, grep\n---\n\nYou are a scout.`;
    const agent = parseAgentFile(raw, "global");

    expect(agent.name).toBe("scout");
    expect(agent.description).toBe("Recon");
    expect(agent.tools).toEqual(["read", "grep"]);
    expect(agent.systemPrompt).toBe("You are a scout.");
  });

  it("parses a BOM'd .gg/commands/*.md custom command", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bom-commands-"));
    try {
      const dir = path.join(cwd, ".gg", "commands");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "deploy.md"),
        `${BOM}---\nname: deploy\ndescription: Ship it\n---\n\nDeploy the app.`,
      );

      const commands = await loadCustomCommands(cwd);

      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe("deploy");
      expect(commands[0].description).toBe("Ship it");
      expect(commands[0].prompt).toBe("Deploy the app.");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("case-insensitive skill invocation", () => {
  const skills = [
    {
      name: "Fancy-Skill",
      description: "Does fancy things",
      content: "Instructions.",
      source: "test",
    },
  ];

  it.each(["Fancy-Skill", "fancy-skill", "FANCY-SKILL"])("resolves %s", async (requested) => {
    const tool = createSkillTool(skills);

    const result = await tool.execute(
      { skill: requested },
      { signal: new AbortController().signal, toolCallId: "skill-1" },
    );

    expect(String(result)).toContain('<skill_content name="Fancy-Skill">');
    expect(String(result)).toContain("Instructions.");
  });

  it("still reports unknown skills with the available list", async () => {
    const tool = createSkillTool(skills);

    const result = await tool.execute(
      { skill: "nope" },
      { signal: new AbortController().signal, toolCallId: "skill-2" },
    );

    expect(String(result)).toContain('Skill "nope" not found');
    expect(String(result)).toContain("Fancy-Skill");
  });
});
