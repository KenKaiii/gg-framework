// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSpot,
  PATCH_COLS,
  patchOffset,
  WAKE_LINES,
  WakeScreen,
  withEyesClosed,
  type WakeMode,
} from "./WakeScreen";
import { CRITTER_CELLS, CRITTERS, renderCritterFrame } from "./critter-sprites";
import {
  BIOMES,
  DECOR_COLS,
  TERRAIN_FLOOR_ROW,
  TERRAIN_PX,
  TERRAIN_ROWS,
  renderTerrain,
} from "./critter-terrain";

const MODES = ["code", "chat", "motion", "goals"] as const satisfies readonly WakeMode[];

/** A random source that always returns `value` (0 ≤ value < 1). */
const fixed = (value: number) => (): number => value;

/**
 * Advance time until the typing comes to rest (bounded at 60s of fake time).
 * Steps in 1s chunks and stops once the cursor rests: stepping timer by timer
 * re-renders on every keystroke and blink, which is too slow on CI runners.
 */
function typeToRest(container: HTMLElement): void {
  for (let i = 0; i < 60; i++) {
    if (container.querySelector(".wake-cursor-rest")) return;
    act(() => vi.advanceTimersByTime(1000));
  }
}

const bubbleText = (container: HTMLElement): string =>
  container.querySelector(".wake-bubble-text")?.textContent ?? "";

describe("WAKE_LINES", () => {
  it.each(MODES)("%s has five distinct line sets, each ending on its own invitation", (mode) => {
    const sets = WAKE_LINES[mode];
    expect(sets).toHaveLength(5);
    expect(new Set(sets.map((set) => set.join("|"))).size).toBe(5);
    expect(new Set(sets.map((set) => set[set.length - 1])).size).toBe(5);
    for (const set of sets) {
      expect(set.length).toBeGreaterThanOrEqual(2);
      for (const line of set) expect(line.trim()).toBe(line);
    }
  });
});

describe("clearSpot", () => {
  it.each(BIOMES.map((b) => [b.id, b] as const))(
    "%s: nothing standing near the critter's spot",
    (_id, biome) => {
      const spot = clearSpot(biome);
      const floor = TERRAIN_ROWS - TERRAIN_FLOOR_ROW;
      const half = 9; // the critter is 18 cells wide
      for (const p of renderTerrain(biome).props) {
        if (p.layer === "sunk" || p.bottom - floor >= 18) continue;
        // Compare on the repeating strip, from the spot's point of view.
        const start = (((p.x - spot) % DECOR_COLS) + DECOR_COLS) % DECOR_COLS;
        const end = start + p.width;
        const overlaps = start < half || end > DECOR_COLS - half;
        expect(overlaps, `prop at ${p.x} (width ${p.width}) vs spot ${spot}`).toBe(false);
      }
    },
  );
});

describe("patchOffset", () => {
  it.each([0, 20, 42.5, 87, 124, 127])("puts spot %s in the patch's middle", (spot) => {
    const offset = patchOffset(spot);
    expect(offset).toBeLessThanOrEqual(0);
    expect(offset).toBeGreaterThan(-DECOR_COLS);
    // The spot (on some repeat of the strip) lands within a cell of the middle.
    const landed = ((((spot + offset) % DECOR_COLS) + DECOR_COLS) % DECOR_COLS) - PATCH_COLS / 2;
    expect(Math.abs(landed) <= 1 || Math.abs(landed + DECOR_COLS) <= 1).toBe(true);
  });
});

describe("withEyesClosed", () => {
  it.each(CRITTERS.map((c) => [c.id, c] as const))(
    "%s: changes the eyes and nothing else",
    (_id, c) => {
      const closed = withEyesClosed(c);
      expect(closed.rows).toHaveLength(c.rows.length);
      expect(closed.rows).not.toEqual(c.rows);
      closed.rows.forEach((row, i) => expect(row).toHaveLength(c.rows[i]?.length ?? -1));
    },
  );

  it.each(CRITTERS.map((c) => [c.id, c] as const))(
    "%s: renders its blink as its own image, not the cached open eyes",
    (_id, c) => {
      expect(renderCritterFrame(withEyesClosed(c), 0)).not.toBe(renderCritterFrame(c, 0));
    },
  );
});

describe("WakeScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(MODES)("%s: types a line set into the bubble and rests on its invitation", (mode) => {
    const { container } = render(
      <WakeScreen
        chat={mode === "chat"}
        motion={mode === "motion"}
        goals={mode === "goals"}
        random={fixed(0.5)}
      />,
    );
    const invitations: string[] = WAKE_LINES[mode].map((set) => set[set.length - 1] ?? "");
    typeToRest(container);
    expect(invitations).toContain(bubbleText(container));
    expect(container.querySelector(".wake-cursor-rest")).not.toBeNull();
  });

  it("picks different line sets for different sessions", () => {
    const seen = new Set<string>();
    for (const value of [0, 0.25, 0.45, 0.65, 0.85]) {
      const { container, unmount } = render(<WakeScreen random={fixed(value)} />);
      typeToRest(container);
      seen.add(bubbleText(container));
      unmount();
    }
    expect(seen.size).toBe(5);
  });

  it("stands a critter on a terrain, with the old Matrix rain gone", () => {
    const { container } = render(<WakeScreen random={fixed(0.3)} />);
    expect(container.querySelector(".wake-critter img")).not.toBeNull();
    expect(container.querySelector(".critter-terrain")).not.toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("sizes the critter's box to its sprite, so it is never squashed", () => {
    const { container } = render(<WakeScreen random={fixed(0.3)} />);
    const scene = container.querySelector<HTMLElement>(".wake-scene");
    expect(scene?.style.getPropertyValue("--wake-critter")).toBe(`${CRITTER_CELLS * TERRAIN_PX}px`);
    expect(container.querySelector(".wake-critter .critter-shadow")).not.toBeNull();
  });

  it("hops and replies when the critter is poked, then goes back to its line", () => {
    const { container } = render(<WakeScreen random={fixed(0.1)} />);
    typeToRest(container);
    const invitation = bubbleText(container);
    const critter = container.querySelector<HTMLButtonElement>(".wake-critter");
    if (!critter) throw new Error("critter missing");
    expect(critter.getAttribute("aria-label")).toMatch(/^Say hi to the /);

    fireEvent.click(critter);
    expect(container.querySelector(".wake-hop")).not.toBeNull();
    expect(bubbleText(container)).not.toBe(invitation);

    act(() => vi.advanceTimersByTime(1500));
    expect(bubbleText(container)).toBe(invitation);
  });

  it("shows the invitation at once for reduced motion, with no weather", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const { container } = render(<WakeScreen chat random={fixed(0.2)} />);
      const set = WAKE_LINES.chat[1];
      expect(bubbleText(container)).toBe(set[set.length - 1]);
      expect(container.querySelector(".wake-weather")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
