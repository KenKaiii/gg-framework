import { useEffect, useRef } from "react";
import { createCritterFloor, type FloorAgent } from "./critter-floor";
import { CritterTerrain } from "./CritterTerrain";
import { TERRAIN_CLOSE_MS, TERRAIN_LAND_MS } from "./critter-terrain";
import { homeRoster } from "./home-roster";
import { useRandomBiome } from "./use-random-biome";

/** Enough company to feel alive without turning the plan into a playground. */
const CREW_SIZE = 4;
/** Land after the pane has dissolved in, so the arrivals are the second beat. */
const ENTRY_DELAY_MS = 420;

/** A random handful of the roster (Fisher-Yates over `random`). */
export function planCrew(random: () => number, size = CREW_SIZE): FloorAgent[] {
  const roster = homeRoster();
  for (let i = roster.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = roster[i];
    const b = roster[j];
    if (a && b) {
      roster[i] = b;
      roster[j] = a;
    }
  }
  return roster.slice(0, size);
}

/**
 * A small crew of critters hanging out on a random terrain along the top of
 * the plan review's activity bar: the same spot (and engine) the chat's
 * sub-agent floor uses, in its ambient mode. Decorative, so hidden from
 * assistive tech.
 */
export function PlanCritters({
  random = Math.random,
}: {
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
}): React.ReactElement {
  const laneRef = useRef<HTMLDivElement>(null);
  const [biome] = useRandomBiome(random);

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
      // A plan is being read: they come and go, but nothing else happens.
      stage: { happenings: false },
    });
    const entry = window.setTimeout(() => controller.sync(planCrew(random)), ENTRY_DELAY_MS);
    return () => {
      window.clearTimeout(entry);
      controller.destroy();
    };
  }, [random]);

  return (
    <div
      className="critter-lane with-terrain plan-review-critters"
      ref={laneRef}
      aria-hidden="true"
    >
      <CritterTerrain biome={biome} />
    </div>
  );
}
