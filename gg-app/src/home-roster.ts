import type { FloorAgent } from "./critter-floor";
import { CRITTERS } from "./critter-sprites";

/** How many of the roster are out on the home screen at a time. */
export const HOME_CREW_SIZE = 9;

/**
 * Every critter as a pretend agent. The ones `here` (everyone, by default)
 * are always busy, so they stay out and play; the rest have finished, so they
 * leave if they're out and stay away until they're `here` again.
 */
export function homeRoster(here?: ReadonlySet<string>): FloorAgent[] {
  return CRITTERS.map((critter): FloorAgent => ({
    key: `home:${critter.id}`,
    agentName: undefined,
    critterId: critter.id,
    label: critter.name,
    status: !here || here.has(critter.id) ? "running" : "done",
    activity: undefined,
    tokens: null,
    durationMs: undefined,
    toolUseCount: 0,
  }));
}

function shuffled<T>(list: readonly T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

/** A random crew to start the home screen with. */
export function pickHomeCrew(random: () => number, size = HOME_CREW_SIZE): Set<string> {
  const ids = CRITTERS.map((critter) => critter.id);
  return new Set(shuffled(ids, random).slice(0, size));
}

/** Who heads off next, and who off the bench turns up in their place (`n` of each). */
export function swapHomeCrew(
  here: ReadonlySet<string>,
  random: () => number,
  n: number,
): { going: string[]; coming: string[] } {
  const ids = CRITTERS.map((critter) => critter.id);
  const bench = shuffled(
    ids.filter((id) => !here.has(id)),
    random,
  );
  const going = shuffled(
    ids.filter((id) => here.has(id)),
    random,
  ).slice(0, Math.min(n, bench.length));
  return { going, coming: bench.slice(0, going.length) };
}
