import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { levelForXp, xpForLevel } from "./ranks.js";
import { rebuildFromSessions } from "./rebuild.js";

let sessionsDir: string;

beforeEach(async () => {
  sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-sessions-"));
});

afterEach(async () => {
  await fs.rm(sessionsDir, { recursive: true, force: true });
});

function sessionJsonl(id: string, timestamp: string, userPrompts: number): string {
  const lines = [JSON.stringify({ type: "session", version: 2, id, timestamp, cwd: "/x" })];
  for (let i = 0; i < userPrompts; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `m${i}`,
        parentId: null,
        timestamp,
        message: { role: "user", content: `prompt ${i}` },
      }),
      JSON.stringify({
        type: "message",
        id: `a${i}`,
        parentId: `m${i}`,
        timestamp,
        message: { role: "assistant", content: "ok" },
      }),
    );
  }
  return lines.join("\n") + "\n";
}

async function writeSession(project: string, name: string, content: string): Promise<void> {
  const dir = path.join(sessionsDir, project);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), content);
}

describe("rebuildFromSessions", () => {
  it("returns null when there is no history", async () => {
    expect(await rebuildFromSessions(sessionsDir)).toBeNull();
    expect(await rebuildFromSessions(path.join(sessionsDir, "missing"))).toBeNull();
  });

  it("awards +10 per historical user prompt", async () => {
    await writeSession("_proj_a", "s1.jsonl", sessionJsonl("s1", "2025-01-01T00:00:00Z", 7));
    const file = await rebuildFromSessions(sessionsDir);
    expect(file).not.toBeNull();
    expect(file!.xp).toBe(70);
    expect(file!.totals.prompts).toBe(7);
    expect(file!.xpBySource.prompts).toBe(70);
  });

  it("gives full credit up to level 15, then diminishing returns beyond", async () => {
    // Right at the level-15 floor: 762 prompts × 10 = 7620 ≈ xpForLevel(15).
    await writeSession("_proj_a", "s1.jsonl", sessionJsonl("s1", "2025-01-01T00:00:00Z", 762));
    const file = await rebuildFromSessions(sessionsDir);
    expect(levelForXp(file!.xp)).toBe(15);
  });

  it("spreads heavy prior users past level 15 instead of clamping them all onto it", async () => {
    await writeSession("_light", "s1.jsonl", sessionJsonl("s1", "2025-01-01T00:00:00Z", 1500));
    const light = await rebuildFromSessions(sessionsDir);

    await fs.rm(sessionsDir, { recursive: true, force: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await writeSession("_heavy", "s1.jsonl", sessionJsonl("s1", "2025-01-01T00:00:00Z", 4000));
    const heavy = await rebuildFromSessions(sessionsDir);

    // Both clamped onto 15 before; now they land on different, higher levels.
    expect(levelForXp(light!.xp)).toBeGreaterThan(15);
    expect(levelForXp(heavy!.xp)).toBeGreaterThan(levelForXp(light!.xp));
  });

  it("never seeds above the hard cap (level 25)", async () => {
    await writeSession("_proj_a", "s1.jsonl", sessionJsonl("s1", "2025-01-01T00:00:00Z", 100000));
    const file = await rebuildFromSessions(sessionsDir);
    expect(levelForXp(file!.xp)).toBe(25);
    expect(file!.xp).toBe(xpForLevel(25));
  });

  it("uses the oldest session timestamp as createdAt and counts projects", async () => {
    await writeSession("_proj_a", "s1.jsonl", sessionJsonl("s1", "2024-06-15T00:00:00Z", 3));
    await writeSession("_proj_b", "s2.jsonl", sessionJsonl("s2", "2023-02-01T00:00:00Z", 2));
    const file = await rebuildFromSessions(sessionsDir);
    expect(file!.createdAt).toBe("2023-02-01T00:00:00Z");
    expect(file!.totals.projects).toHaveLength(2);
  });

  it("skips malformed lines and empty sessions", async () => {
    await writeSession("_proj_a", "bad.jsonl", "not json\n{broken\n");
    await writeSession("_proj_a", "s1.jsonl", sessionJsonl("s1", "2025-01-01T00:00:00Z", 1));
    const file = await rebuildFromSessions(sessionsDir);
    expect(file!.xp).toBe(10);
  });
});
