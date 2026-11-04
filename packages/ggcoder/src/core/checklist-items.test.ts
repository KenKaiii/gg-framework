import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKLIST_GROUPS,
  CHECKLIST_IDS,
  CHECKLIST_ITEMS,
  type ChecklistItem,
} from "./checklist-items.js";
import { PROMPT_COMMANDS } from "./prompt-commands.js";

const ITEMS: readonly ChecklistItem[] = CHECKLIST_ITEMS;

const SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/skills",
);

describe("checklist items", () => {
  it("has 23 items with unique ids", () => {
    expect(CHECKLIST_ITEMS).toHaveLength(23);
    expect(new Set(CHECKLIST_IDS).size).toBe(CHECKLIST_ITEMS.length);
  });

  it("keeps purpose hints short, first-person and free of em dashes", () => {
    for (const item of CHECKLIST_ITEMS) {
      expect(item.description.length, item.id).toBeLessThanOrEqual(120);
      expect(item.description, item.id).toMatch(/\bI\b/);
      expect(item.description, item.id).not.toMatch(/[\n\u2014]/);
    }
  });

  it("keeps items of a group together, in group order", () => {
    const order = CHECKLIST_ITEMS.map((i) => CHECKLIST_GROUPS.indexOf(i.group));
    expect(order.every((g) => g >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it.each(ITEMS.filter((i) => i.skill).map((i) => [i.id, i.skill] as const))(
    "%s uses a bundled skill (%s)",
    (_id, skill) => {
      expect(fs.existsSync(path.join(SKILLS_DIR, String(skill), "SKILL.md"))).toBe(true);
    },
  );

  it.each(ITEMS.filter((i) => i.setupCommand).map((i) => [i.id, i.setupCommand] as const))(
    "%s points to a real setup command (/%s)",
    (_id, command) => {
      expect(PROMPT_COMMANDS.some((c) => c.name === command)).toBe(true);
    },
  );
});
