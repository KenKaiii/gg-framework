import { describe, expect, it } from "vitest";
import { KEN_LINES, WORKER_LINES, pickWorkLine } from "./goal-farm-lines";
import { M5X7 } from "./pixel-font-m5x7";
import { BUBBLE_TEXT_MAX } from "./goal-farm-render";
import { textWidth, wrapText } from "./pixel-text";
import { WORK_KINDS } from "./goal-world-agents";
import { createFarmWorld, stepFarm, syncFarm } from "./goal-farm-sim";
import { buildFarm } from "./goal-farm-map";
import type { WorldAgent } from "./goal-world-agents";

const all = [...Object.values(WORKER_LINES), ...Object.values(KEN_LINES)].flat();

describe("what the farm's critters say", () => {
  it("has about ten different lines for every kind of work, for workers and for Ken", () => {
    for (const kind of WORK_KINDS) {
      for (const lines of [WORKER_LINES[kind], KEN_LINES[kind]]) {
        expect(lines.length, kind).toBeGreaterThanOrEqual(10);
        expect(new Set(lines).size, kind).toBe(lines.length);
      }
    }
    // Ken's lines are his own, not the workers' with his name on.
    const shared = KEN_LINES.read.filter((l) => WORKER_LINES.read.includes(l));
    expect(shared.length).toBeLessThan(3);
  });

  it("says only what the pixel font can draw, in at most two short lines", () => {
    for (const line of all) {
      for (const ch of line) {
        if (ch !== " ") expect(M5X7[ch], `${line} (${ch})`).toBeDefined();
      }
      const lines = wrapText(line, BUBBLE_TEXT_MAX);
      expect(lines.length, line).toBeLessThanOrEqual(2);
      expect(lines.join(" "), line).toBe(line);
      for (const l of lines) expect(textWidth(l), line).toBeLessThanOrEqual(BUBBLE_TEXT_MAX);
    }
  });

  it("never says the same line twice in a row", () => {
    for (const kind of WORK_KINDS) {
      let last: string | null = null;
      for (let i = 0; i < 40; i++) {
        const line = pickWorkLine(false, kind, (i * 0.37) % 1, last);
        expect(line).not.toBe(last);
        last = line;
      }
    }
  });

  it("speaks up now and then on a new job, spaced out, never spamming", () => {
    // Every roll says yes: only the gaps hold it back.
    const world = createFarmWorld(buildFarm(), () => 0.01);
    const kinds = ["read", "search", "edit", "run", "web", "think"] as const;
    const said: string[] = [];
    for (let t = 0, i = 0; t < 60_000; t += 500, i++) {
      const agent: WorldAgent = {
        key: "w",
        agentName: undefined,
        name: "Worker",
        coordinator: false,
        status: "working",
        // A new job every second: far more often than it may speak.
        kind: kinds[Math.floor(i / 2) % kinds.length] ?? "read",
        detail: "x",
      };
      syncFarm(world, [agent], t);
      stepFarm(world, t);
      const bubble = world.actors.get("w")?.bubble?.text;
      if (bubble && bubble !== said[said.length - 1]) said.push(bubble);
    }
    // At most one line per gap (9s) over a minute of job changes.
    expect(said.length).toBeGreaterThan(2);
    expect(said.length).toBeLessThanOrEqual(7);
    for (const line of said) expect(all).toContain(line);
  });
});
