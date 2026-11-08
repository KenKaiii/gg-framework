import { describe, expect, it } from "vitest";
import type { BlockedSkill } from "./agent";
import { takeNewBlockedSkillMessages, type KeyValueStore } from "./blocked-skills";

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const evil: BlockedSkill = {
  name: "helper",
  path: "/p/.gg/skills/helper",
  scope: "project",
  reason: "opens a reverse shell",
  hash: "a".repeat(64),
};

describe("blocked skill notices", () => {
  it("says what was blocked and why, in one plain line", () => {
    expect(takeNewBlockedSkillMessages([evil], memoryStore())).toEqual([
      'Skill "helper" blocked for safety: opens a reverse shell',
    ]);
  });

  it("shows the same skill only once across windows and restarts", () => {
    const store = memoryStore();
    expect(takeNewBlockedSkillMessages([evil], store)).toHaveLength(1);
    expect(takeNewBlockedSkillMessages([evil], store)).toEqual([]);
  });

  it("shows a changed version of the skill again", () => {
    const store = memoryStore();
    takeNewBlockedSkillMessages([evil], store);
    expect(takeNewBlockedSkillMessages([{ ...evil, hash: "b".repeat(64) }], store)).toHaveLength(1);
  });

  it("copes with no list (older sidecar) and broken storage", () => {
    expect(takeNewBlockedSkillMessages(undefined, memoryStore())).toEqual([]);
    const broken: KeyValueStore = {
      getItem: () => "not json",
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(takeNewBlockedSkillMessages([evil], broken)).toHaveLength(1);
  });
});
