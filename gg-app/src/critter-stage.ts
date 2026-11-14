// The critter stage: everything on the floor beyond the critters' own
// behaviour. How they look (critter-looks), the name tag (critter-tag), the
// many ways to arrive and leave (critter-arrivals, critter-exits), the monster
// and Ken (critter-monster), and things that happen by themselves
// (critter-happenings). The engine (critter-floor.ts) calls into it at a
// dozen points and otherwise knows nothing about it.
//
// Every delay here goes through the engine's `later`, so a resting window
// freezes a show mid-step and resumes it. With reduced motion only the tag
// and the static emotes are left.

import { makeCritterArrivals } from "./critter-arrivals";
import { makeCritterExits, type Leaver } from "./critter-exits";
import { makeCritterHappenings } from "./critter-happenings";
import { makeCritterLooks } from "./critter-looks";
import { makeCritterMonster } from "./critter-monster";
import { makeStageKit, type StageHost } from "./critter-stage-kit";
import { makeCritterTag, type CritterTag } from "./critter-tag";
import type { Critter } from "./critter-types";

export interface CritterStage {
  tick(t: number, dt: number): void;
  /** A new critter: blinks, breathing, something to wear. */
  dress(c: Critter): void;
  /** Called whenever a critter is placed. */
  ground(c: Critter): void;
  /** Bring a new critter in. False: the engine beams it in the classic way. */
  arrive(c: Critter, settle: () => void): boolean;
  /** See a leaving critter off. False: the engine does it the classic way. */
  depart(leaver: Leaver): boolean;
  /** A failed critter tips over, and its spirit leaves. */
  fall(c: Critter): void;
  /** Lying on the ground: no more hovering. */
  downed(c: Critter): boolean;
  noteAct(c: Critter, key: string, id: string): void;
  readonly tag: Pick<CritterTag, "show" | "hide" | "pin" | "drop">;
  /** A show is on that needs the lane kept open (see StageHost.onQuiet). */
  busy(): boolean;
  destroy(): void;
}

export function makeCritterStage(host: StageHost): CritterStage {
  const kit = makeStageKit(host);
  const looks = makeCritterLooks(kit);
  const tag = makeCritterTag(kit);
  const arrivals = makeCritterArrivals(kit);
  const monster = makeCritterMonster(kit, host.onQuiet);
  const exits = makeCritterExits(kit, arrivals.saucer, monster);
  const happenings = makeCritterHappenings(kit, arrivals.saucer, monster, looks);

  return {
    tick(t, dt) {
      if (!kit.alive()) return;
      looks.tick();
      tag.tick();
      if (!host.reduced) happenings.tick(t, dt);
    },
    dress: looks.dress,
    ground: looks.ground,
    arrive: arrivals.arrive,
    depart(leaver) {
      // Called away before it had landed: no show, just the classic way out.
      if (arrivals.cut(leaver.c)) return false;
      return exits.depart(leaver);
    },
    fall(c) {
      arrivals.cut(c);
      looks.fall(c);
      looks.soul(c);
    },
    downed: looks.downed,
    noteAct: tag.noteAct,
    tag,
    busy: monster.out,
    destroy() {
      kit.stop();
      tag.destroy();
    },
  };
}
