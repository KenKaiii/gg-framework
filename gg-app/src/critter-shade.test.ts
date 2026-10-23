import { describe, expect, it } from "vitest";
import { CRITTERS } from "./critter-sprites";
import { shadeGrid } from "./critter-shade";

/** Perceived brightness of a shaded cell (null when clear). */
function brightness(c: string | null | undefined): number | null {
  if (!c) return null;
  const m = /^rgba?\((\d+),(\d+),(\d+)/.exec(c);
  const [r, g, b] = m
    ? [Number(m[1]), Number(m[2]), Number(m[3])]
    : [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  return 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0);
}

describe("shadeGrid", () => {
  // A plain round blob: one part, one outline.
  const blob = [
    "..OOOOOO..",
    ".OBBBBBBO.",
    "OBBBBBBBBO",
    "OBBBBBBBBO",
    "OBBBBBBBBO",
    "OBBBBBBBBO",
    ".OBBBBBBO.",
    "..OOOOOO..",
  ];
  const palette = { O: "#000", B: "#4a90d0" };

  it("is the same every time for the same grid", () => {
    expect(shadeGrid({ rows: blob, palette })).toEqual(shadeGrid({ rows: blob, palette }));
  });

  it("keeps clear cells clear and fills every drawn cell", () => {
    const out = shadeGrid({ rows: blob, palette });
    blob.forEach((row, y) =>
      [...row].forEach((ch, x) => expect(out[y]?.[x] === null, `${x},${y}`).toBe(ch === ".")),
    );
  });

  it("lights a part from the top left and shades it to the bottom right", () => {
    const out = shadeGrid({ rows: blob, palette });
    const topLeft = brightness(out[2]?.[2]);
    const bottomRight = brightness(out[5]?.[7]);
    expect(topLeft).not.toBeNull();
    expect(bottomRight).not.toBeNull();
    expect(topLeft ?? 0).toBeGreaterThan((bottomRight ?? 0) + 20);
  });

  it("uses several tones on a part, not one flat fill", () => {
    const out = shadeGrid({ rows: blob, palette });
    const body = new Set(out.flatMap((row, y) => row.filter((_, x) => blob[y]?.[x] === "B")));
    expect(body.size).toBeGreaterThanOrEqual(3);
  });

  it("colours the outline darker than what it wraps, but never plain black", () => {
    const out = shadeGrid({ rows: blob, palette });
    const line = out[4]?.[0];
    expect(line).not.toBe("#000000");
    expect(brightness(line) ?? 255).toBeLessThan(brightness(out[4]?.[1]) ?? 0);
  });

  it("paints eyes and blush flat, in their own colours", () => {
    const rows = ["OOOO", "OKCO", "OOOO"];
    const out = shadeGrid({ rows, palette: { O: "#000", K: "#1e0c1f", C: "#ff8a5c" } });
    expect(out[1]?.[1]).toBe("#1e0c1f");
    expect(out[1]?.[2]).toBe("#ff8a5c");
  });

  it.each(CRITTERS.map((c) => [c.id, c] as const))("lights %s without gaps", (_id, c) => {
    const out = shadeGrid({ rows: c.rows, palette: c.palette, materials: c.materials });
    c.rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch !== ".") expect(out[y]?.[x], `${c.id} ${x},${y}`).toBeTruthy();
      }),
    );
  });
});
