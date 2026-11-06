import { describe, expect, it } from "vitest";
import { PixelBuffer } from "./goal-map-pixels";
import { lean } from "./goal-map-props";

describe("lean (the high camera)", () => {
  /** How many opaque pixels a row has. */
  const widthAt = (buf: PixelBuffer, y: number): number => {
    let n = 0;
    for (let x = 0; x < buf.width; x++) if (buf.opaque(x, y)) n++;
    return n;
  };

  it("keeps a building widest at its eave and narrows it toward the ground and the back", () => {
    // A roof 40 wide (rows 0-9) overhanging walls 36 wide (rows 10-29), the foot on row 29.
    const buf = new PixelBuffer(40, 30);
    buf.rect(0, 0, 40, 10, 0x8e613a);
    buf.rect(2, 10, 36, 20, 0xc98149);
    const leaned = lean({ buf, ax: 20, ay: 29 }, 0.2, 0.2).buf;
    expect(widthAt(leaned, 9)).toBe(42); // the eave keeps its width, plus its outline
    expect(widthAt(leaned, 10)).toBe(36); // the top of the wall too
    expect(widthAt(leaned, 29)).toBeLessThan(32); // the walls lean in to the ground
    // The roof narrows to the back: even with its outline, well inside the eave.
    expect(widthAt(leaned, 0)).toBeLessThan(widthAt(leaned, 9) - 4);
    // The roof ran to the canvas edge, so it had no outline there; leaned,
    // each of its rows gets one at both ends, darker than the thatch.
    for (let y = 0; y <= 9; y++) {
      const xs = Array.from({ length: leaned.width }, (_, x) => x).filter((x) =>
        leaned.opaque(x, y),
      );
      for (const x of [xs[0] ?? 0, xs[xs.length - 1] ?? 0]) {
        expect(leaned.rgb(x, y)).not.toBe(0x8e613a);
      }
    }
    // Every row stays one solid run: no gaps opened in the middle.
    for (let y = 0; y < 30; y++) {
      const xs = Array.from({ length: leaned.width }, (_, x) => x).filter((x) =>
        leaned.opaque(x, y),
      );
      expect((xs[xs.length - 1] ?? 0) - (xs[0] ?? 0) + 1).toBe(xs.length);
    }
  });
});
