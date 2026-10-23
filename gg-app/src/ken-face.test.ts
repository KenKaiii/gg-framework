import { describe, expect, it } from "vitest";
import { CRITTER_CELLS } from "./critter-sprites";
import { KEN_FACE_PALETTE, kenFaceRows, renderKenFace, type KenFaceFrame } from "./ken-face";

const FRAMES: readonly KenFaceFrame[] = ["base", "blink", "talk", "happy", "sleepy"];

describe("Ken's face", () => {
  it.each(FRAMES)("%s is a full 18×18 grid with every colour defined", (frame) => {
    const rows = kenFaceRows(frame);
    expect(rows).toHaveLength(CRITTER_CELLS);
    for (const row of rows) {
      expect(row).toHaveLength(CRITTER_CELLS);
      for (const ch of row) {
        if (ch !== ".") expect(KEN_FACE_PALETTE[ch], `${frame} "${ch}"`).toBeDefined();
      }
    }
  });

  it("gives every expression its own look", () => {
    const rendered = FRAMES.map(renderKenFace);
    expect(new Set(rendered).size).toBe(FRAMES.length);
  });

  it("only changes the eyes and mouth, so stacked frames line up", () => {
    const base = kenFaceRows("base");
    for (const frame of FRAMES) {
      kenFaceRows(frame).forEach((row, i) => {
        if (row !== base[i]) expect([8, 9, 11, 12], `${frame} row ${i}`).toContain(i);
      });
    }
  });

  it("renders a deterministic 18×18 SVG", () => {
    const svg = decodeURIComponent(renderKenFace("base"));
    expect(svg).toContain('viewBox="0 0 18 18"');
    expect(renderKenFace("base")).toBe(renderKenFace("base"));
  });
});
