import { describe, expect, it } from "vitest";
import {
  burstPieces,
  cellFlights,
  PCT_COLS,
  PLATE_ROWS,
  PLATE_SRC,
  pixelWord,
} from "./update-key-art";

describe("update key art", () => {
  it("lays words out in m5x7 (GG Royale's pixel font), with a blank column between letters", () => {
    const word = pixelWord("XP");
    expect(word.rows).toBe(9);
    expect(word.cols).toBeGreaterThan(8);
    // Ink at the top-left of the X; every cell inside the word's box.
    expect(word.cells.some((c) => c.col === 0 && c.row === 0)).toBe(true);
    expect(word.cells.every((c) => c.col < word.cols && c.row < word.rows)).toBe(true);
    expect(word.cells.every((c) => c.t >= 0 && c.t <= 1)).toBe(true);
    // Lowercase reads as lowercase (m5x7 has both cases).
    expect(pixelWord("Update").cells.length).not.toBe(pixelWord("UPDATE").cells.length);
  });

  it("fits 100% in the columns the XP readout reserves", () => {
    expect(pixelWord("100%").cols).toBeLessThanOrEqual(PCT_COLS);
    expect(pixelWord("7%").cols).toBeLessThan(PCT_COLS);
  });

  it("scatters a word the same way every time", () => {
    const word = pixelWord("Update");
    expect(cellFlights(word, "Update", 70)).toEqual(cellFlights(word, "Update", 70));
    expect(cellFlights(word, "Update", 70)).toHaveLength(word.cells.length);
  });

  it("flings the burst out in every direction", () => {
    const burst = burstPieces();
    expect(burst).toEqual(burstPieces());
    expect(burst.some((p) => p.dx > 0) && burst.some((p) => p.dx < 0)).toBe(true);
    expect(burst.some((p) => p.dy > 0) && burst.some((p) => p.dy < 0)).toBe(true);
  });

  it("gives the plate a size border-image can slice", () => {
    expect(PLATE_ROWS.every((row) => row.length === 12)).toBe(true);
    expect(decodeURIComponent(PLATE_SRC)).toContain('<svg width="12" height="12" ');
  });
});
