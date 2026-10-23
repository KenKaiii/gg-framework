import { describe, expect, it } from "vitest";
import { CRITTERS, CRITTER_CELLS } from "./critter-sprites";
import { GG_FACE_GLOW, ggFaceRows, renderGgFace, type GgFaceFrame } from "./gg-face";

const FRAMES = [
  "ready",
  "blink",
  "happy",
  "curious",
  "worried",
  "sad",
  "shocked",
] as const satisfies readonly GgFaceFrame[];
const robot = CRITTERS.find((c) => c.id === "robot");

describe("gg-face", () => {
  it.each(FRAMES)("%s is a full critter-sized grid", (frame) => {
    const rows = ggFaceRows(frame);
    expect(rows).toHaveLength(CRITTER_CELLS);
    for (const row of rows) expect(row).toHaveLength(CRITTER_CELLS);
  });

  it("is the Robot critter everywhere but its screen (rows 6–8)", () => {
    const ready = ggFaceRows("ready");
    expect(robot).toBeDefined();
    robot?.rows.forEach((row, y) => {
      if (y < 6 || y > 8) expect(ready[y], `row ${y}`).toBe(row);
    });
  });

  it("gives every frame a different face", () => {
    expect(new Set(FRAMES.map((f) => ggFaceRows(f).join("\n"))).size).toBe(FRAMES.length);
  });

  it("only changes the face and its marks, keeping the body", () => {
    const base = ggFaceRows("ready");
    for (const frame of FRAMES) {
      ggFaceRows(frame).forEach((row, y) => {
        if (y >= 10) expect(row, `${frame} row ${y}`).toBe(base[y]);
      });
    }
  });

  it.each(Object.entries(GG_FACE_GLOW))("%s glows in its status colour", (mood, glow) => {
    const svg = decodeURIComponent(renderGgFace(mood as GgFaceFrame));
    expect(svg).toContain(`fill="${glow}"`);
  });
});
