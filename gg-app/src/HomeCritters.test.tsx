// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeCritters } from "./HomeCritters";
import { HOME_CREW_SIZE, homeRoster, pickHomeCrew, swapHomeCrew } from "./home-roster";
import { CRITTERS, renderCritterFrame } from "./critter-sprites";
import { BIOMES, type Biome } from "./critter-terrain";

function biome(id: string): Biome {
  const found = BIOMES.find((b) => b.id === id);
  if (!found) throw new Error(`no ${id} terrain`);
  return found;
}
const MEADOW = biome("meadow");

// jsdom has no Web Animations API; the floor only needs the calls to exist.
beforeAll(() => {
  const fakeAnimation = (): Animation =>
    ({
      finished: Promise.resolve(),
      cancel: () => undefined,
      onfinish: null,
    }) as unknown as Animation;
  Element.prototype.animate = vi.fn(fakeAnimation) as unknown as Element["animate"];
  Element.prototype.getAnimations = vi.fn(() => []) as unknown as Element["getAnimations"];
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A fixed sequence of rolls, so a visit plays the same way every time. */
function seeded(seed = 3): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Which critters are out (not on their way off), by id. */
const crewOut = (container: HTMLElement): string[] => {
  const byFrame = new Map(CRITTERS.map((c) => [renderCritterFrame(c, 0), c.id]));
  return [...container.querySelectorAll(".critter:not(.leaving) .critter-f0")]
    .map((img) => byFrame.get(img.getAttribute("src") ?? "") ?? "?")
    .sort();
};

const terrainOf = (container: HTMLElement): string | null =>
  container.querySelector<HTMLElement>(".home-critters")?.dataset.terrain ?? null;

const sprites = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLImageElement>(".critter .critter-f0")]
    .map((img) => img.getAttribute("src"))
    .filter((src): src is string => src !== null);

describe("homeRoster", () => {
  it("lists every critter once, pinned and named, as a busy pretend agent", () => {
    const roster = homeRoster();
    expect(roster.map((agent) => agent.critterId)).toEqual(CRITTERS.map((c) => c.id));
    expect(roster.map((agent) => agent.label)).toEqual(CRITTERS.map((c) => c.name));
    expect(roster.every((agent) => agent.status === "running")).toBe(true);
  });

  it("keeps only the crew busy: the rest have finished, so they stay off the floor", () => {
    const here = new Set(["fox", "alien"]);
    const busy = homeRoster(here).filter((agent) => agent.status === "running");
    expect(busy.map((agent) => agent.critterId)).toEqual(["fox", "alien"]);
    expect(homeRoster(here).filter((agent) => agent.status === "done")).toHaveLength(
      CRITTERS.length - 2,
    );
  });

  it("picks a crew of nine different critters, and swaps them for ones off the bench", () => {
    const random = seeded();
    const crew = pickHomeCrew(random);
    expect(crew.size).toBe(HOME_CREW_SIZE);
    for (const n of [1, 2]) {
      const { going, coming } = swapHomeCrew(crew, random, n);
      expect(going).toHaveLength(n);
      expect(coming).toHaveLength(n);
      expect(going.every((id) => crew.has(id))).toBe(true);
      expect(coming.some((id) => crew.has(id))).toBe(false);
    }
    // Nobody on the bench: nobody goes.
    const everyone = new Set(CRITTERS.map((c) => c.id));
    expect(swapHomeCrew(everyone, random, 2)).toEqual({ going: [], coming: [] });
  });
});

describe("HomeCritters", () => {
  it.each(BIOMES.map((b) => [b.id, b] as const))("lays down the %s it's given", (id, given) => {
    const { container, unmount } = render(<HomeCritters biome={given} />);
    expect(terrainOf(container)).toBe(id);
    // Inside the critter lane (so it rises with it), ground and props both drawn.
    const terrain = container.querySelector<HTMLElement>(".critter-lane > .critter-terrain");
    const ground = terrain?.querySelector<HTMLElement>(".terrain-land > .terrain-ground");
    expect(ground?.style.backgroundImage).toContain("data:image/svg+xml");
    const props = terrain?.querySelectorAll<HTMLElement>(".terrain-prop") ?? [];
    expect(props.length).toBeGreaterThan(0);
    for (const prop of props) {
      expect(prop.style.getPropertyValue("--img")).toContain("data:image/svg+xml");
    }
    unmount();
  });

  it("brings out a crew of nine, each a different critter", async () => {
    const { container } = render(<HomeCritters biome={MEADOW} />);
    expect(sprites(container)).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    const shown = sprites(container);
    expect(shown).toHaveLength(HOME_CREW_SIZE);
    expect(new Set(shown).size).toBe(HOME_CREW_SIZE);
    const roster = new Set(CRITTERS.map((c) => renderCritterFrame(c, 0)));
    expect(shown.every((src) => roster.has(src))).toBe(true);
  });

  it("keeps the crew out playing without thinking pauses, and cleans up on unmount", async () => {
    // jsdom's window isn't focused, so the floor rests and the crew stays as it is.
    const { container, unmount } = render(<HomeCritters biome={MEADOW} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    const crew = crewOut(container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40000);
    });
    expect(crewOut(container)).toEqual(crew);
    expect(container.querySelector(".critter-thought")).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("changes the crew a critter or two at a time while the window is in use", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { container, unmount } = render(<HomeCritters biome={MEADOW} random={seeded()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    const first = crewOut(container);
    expect(first).toHaveLength(HOME_CREW_SIZE);

    // The first swap: someone heads off, and nobody has come for them yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const during = crewOut(container);
    expect(during.length).toBeLessThan(HOME_CREW_SIZE);
    expect(during.every((id) => first.includes(id))).toBe(true);

    // Then the bench fills the gap: nine again, not the same nine.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    const second = crewOut(container);
    expect(second).toHaveLength(HOME_CREW_SIZE);
    expect(new Set(second).size).toBe(HOME_CREW_SIZE);
    expect(second).not.toEqual(first);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the same nine with reduced motion", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { container, unmount } = render(<HomeCritters biome={MEADOW} random={seeded()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    const crew = crewOut(container);
    expect(crew).toHaveLength(HOME_CREW_SIZE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(crewOut(container)).toEqual(crew);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows the critter's name and what it's up to on hover", async () => {
    const { container } = render(<HomeCritters biome={MEADOW} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    const critter = container.querySelector<HTMLElement>(".critter");
    if (!critter) throw new Error("no critter");
    fireEvent.mouseEnter(critter);

    const names = CRITTERS.map((c) => c.name);
    expect(names).toContain(container.querySelector(".critter-tag-name")?.textContent);
    // No agent behind it: the slip says what the critter itself is doing.
    expect(container.querySelector(".critter-tag-text")?.textContent).toBe("Taking a breather");
    fireEvent.mouseLeave(critter);
    expect(container.querySelector(".critter-tag")).toBeNull();
  });
});
