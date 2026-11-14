import { useEffect, useRef } from "react";
import { createCritterFloor } from "./critter-floor";
import { CritterTerrain } from "./CritterTerrain";
import { TERRAIN_CLOSE_MS, TERRAIN_LAND_MS, type Biome } from "./critter-terrain";
import { homeRoster, pickHomeCrew, swapHomeCrew } from "./home-roster";
import { readMotionLevel } from "./window-motion";

/** Let the home page assemble (its reveal-up entry) before the first one lands. */
const ENTRY_DELAY_MS = 600;
/** About this often one of the crew (now and then two) heads off… */
const SWAP_EVERY_MS = 13_000;
/** …and this long after, someone off the bench turns up in their place. */
const SWAP_GAP_MS = 2600;

interface Props {
  /** The terrain they live on; the home screen picks one each visit. */
  biome: Biome;
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
}

/**
 * A crew of critters living along the bottom of the home screen, on the
 * visit's terrain (meadow, beach, desert, space, snow). The ground rises out
 * of the window's bottom edge, then nine of the roster turn up (by saucer,
 * parachute, on foot…), wander, meet, bonk and play with each other, and spook
 * when clicked: the same engine as the chat's sub-agent floor, in its ambient
 * mode, with open sky above it. The crew keeps changing: every so often one
 * heads off and another turns up. With reduced motion the nine stay put.
 * Decorative, so hidden from assistive tech.
 */
export function HomeCritters({ biome, random = Math.random }: Props): React.ReactElement {
  const laneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const controller = createCritterFloor(lane, {
      reducedMotion,
      ambient: true,
      landAfterMs: TERRAIN_LAND_MS,
      closeAfterMs: TERRAIN_CLOSE_MS,
      random,
      stage: { tall: true },
    });
    let here = pickHomeCrew(random);
    const entry = window.setTimeout(() => controller.sync(homeRoster(here)), ENTRY_DELAY_MS);
    let arrival = 0;
    const swap = (): void => {
      // A window nobody is looking at keeps its crew: they would only blink in and out.
      if (readMotionLevel() !== "full") return;
      const { going, coming } = swapHomeCrew(here, random, random() < 0.3 ? 2 : 1);
      here = new Set([...here].filter((id) => !going.includes(id)));
      controller.sync(homeRoster(here));
      arrival = window.setTimeout(() => {
        here = new Set([...here, ...coming]);
        controller.sync(homeRoster(here));
      }, SWAP_GAP_MS);
    };
    const rotation = reducedMotion ? 0 : window.setInterval(swap, SWAP_EVERY_MS);
    return () => {
      window.clearTimeout(entry);
      window.clearInterval(rotation);
      window.clearTimeout(arrival);
      controller.destroy();
    };
  }, [random]);

  return (
    <div className="home-critters" data-terrain={biome.id} aria-hidden="true">
      {/* Terrain first, so the floor the engine appends paints over it. */}
      <div className="critter-lane with-terrain" ref={laneRef}>
        <CritterTerrain biome={biome} />
      </div>
    </div>
  );
}
