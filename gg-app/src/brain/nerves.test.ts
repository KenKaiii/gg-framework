import { describe, expect, it } from "vitest";
import { edgeVisibility, joinBase, mixColor } from "./nerves";

describe("edgeVisibility", () => {
  it("draws a nerve whole while its card is in view and fades it out past the list's edge", () => {
    expect(edgeVisibility(200, 100, 500)).toBe(1);
    expect(edgeVisibility(100, 100, 500)).toBe(1);
    expect(edgeVisibility(86, 100, 500)).toBeCloseTo(0.5);
    expect(edgeVisibility(514, 100, 500)).toBeCloseTo(0.5);
    // Scrolled well out: no nerve left hanging from the list's edge.
    expect(edgeVisibility(40, 100, 500)).toBe(0);
    expect(edgeVisibility(900, 100, 500)).toBe(0);
  });
});

describe("joinBase", () => {
  it("keeps the join inside the edge's straight run, clear of the rounded corners", () => {
    // A 56px-tall card with 14px corners has 28px of straight edge: 13px each side.
    expect(joinBase(56, 14)).toBe(12);
    expect(joinBase(46, 14)).toBe(8);
    // Never narrower than the nerve it hands over to.
    expect(joinBase(20, 14)).toBeGreaterThan(2.4);
  });
});

describe("mixColor", () => {
  it("matches CSS color-mix(in srgb, b t, transparent) painted over a", () => {
    // The card's port glow: 16% of the accent over the card surface.
    expect(mixColor("#1f2226", "#8fa3ff", 0.16)).toBe("rgb(49,55,73)");
    expect(mixColor("#000", "#fff", 0.5)).toBe("rgb(128,128,128)");
    expect(mixColor("rgb(10, 20, 30)", "#0a141e", 1)).toBe("rgb(10,20,30)");
  });
});
