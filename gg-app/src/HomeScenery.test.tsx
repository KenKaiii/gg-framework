// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeScenery, withScenery } from "./HomeScenery";
import { HOME_CONTENT_HALF, homeLayout } from "./clearing-art";
import { BIOMES } from "./critter-terrain";

beforeEach(() => {
  // jsdom has no 2D canvas: the scenery must quietly draw nothing.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("withScenery", () => {
  it("puts the critters on grass in the campfire's clearing, whatever the visit picked", () => {
    for (const biome of BIOMES) {
      expect(withScenery(biome).id).toBe("meadow");
    }
  });
});

describe("HomeScenery", () => {
  it("renders a decorative canvas, hidden from assistive tech, even without 2D canvas", () => {
    const { container } = render(<HomeScenery hour={18.75} />);
    const scenery = container.querySelector<HTMLElement>(".home-scenery");
    expect(scenery?.getAttribute("aria-hidden")).toBe("true");
    expect(scenery?.querySelector("canvas")).not.toBeNull();
  });
});

// The home clearing in art px (2 screen px each): 1280×800 is 640×400.
describe("homeLayout", () => {
  it("is the same clearing every time for the same window and hour", () => {
    expect(homeLayout(640, 400, 18.4)).toEqual(homeLayout(640, 400, 18.4));
  });

  it("keeps the pines at the edges, leaving the middle open for the logo and buttons", () => {
    const { pines, w } = homeLayout(640, 400, 18.4);
    expect(pines.length).toBeGreaterThan(0);
    for (const pine of pines) expect(pine.x < w * 0.3 || pine.x > w * 0.7).toBe(true);
  });

  it("lights each pine on the side facing the middle", () => {
    const { pines, w } = homeLayout(640, 400, 18.4);
    for (const pine of pines) expect(pine.light).toBe(pine.x < w / 2 ? 1 : -1);
  });

  it.each([
    [640, 400],
    [450, 300],
    [960, 540],
  ])(
    "puts the fire in the middle of the field, above the critters' lane, in a %ix%i window",
    (w, h) => {
      const { fire, horizon } = homeLayout(w, h, 21);
      expect(fire.x).toBe(Math.round(w / 2));
      expect(fire.base).toBeGreaterThan(horizon);
      // The lane opens ~45 art px tall for the critters' speech bubbles.
      expect(fire.base).toBeLessThanOrEqual(h - 48);
    },
  );

  it("sits the owl on a pine at the left, inside the window", () => {
    const { owl, w, h } = homeLayout(640, 400, 23.5);
    expect(owl).not.toBeNull();
    expect(owl?.x).toBeLessThan(w * 0.2);
    expect(owl?.y).toBeGreaterThan(0);
    expect(owl?.y).toBeLessThan(h);
  });

  it("stays sane in a tiny window", () => {
    const layout = homeLayout(10, 15, 12);
    expect(layout.horizon).toBeGreaterThan(0);
    expect(layout.horizon).toBeLessThan(layout.h);
  });
});

describe("the home sun", () => {
  // Windows wide enough for the sun beside the row of plate buttons.
  it.each([
    [640, 400],
    [800, 450],
    [960, 540],
  ])("never sits behind the logo or buttons in a %ix%i window", (w, h) => {
    for (let minute = 0; minute < 24 * 60; minute += 5) {
      const { sun } = homeLayout(w, h, minute / 60);
      if (!sun || sun.y + sun.r < 0) continue;
      expect(Math.abs(sun.x - w / 2)).toBeGreaterThanOrEqual(HOME_CONTENT_HALF + sun.r - 0.5);
    }
  });

  it("keeps inside a narrow window, at its edge", () => {
    for (let minute = 0; minute < 24 * 60; minute += 15) {
      const { sun, w } = homeLayout(450, 300, minute / 60);
      if (!sun) continue;
      expect(sun.x - sun.r).toBeGreaterThanOrEqual(0);
      expect(sun.x + sun.r).toBeLessThanOrEqual(w);
    }
  });

  it("rises on the left and sets on the right", () => {
    expect(homeLayout(640, 400, 7).sun?.x).toBeLessThan(320);
    expect(homeLayout(640, 400, 18.5).sun?.x).toBeGreaterThan(320);
  });
});
