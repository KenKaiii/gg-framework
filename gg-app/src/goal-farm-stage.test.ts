// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { FARM_EXITS, type FarmExit } from "./goal-farm-comings";
import { createPlay, type FarmPlay } from "./goal-farm-interact";
import { buildFarm } from "./goal-farm-map";
import { drawFarm, farmTargets } from "./goal-farm-render";
import {
  createFarmWorld,
  farmIsMoving,
  stepFarm,
  syncFarm,
  type Actor,
  type FarmWorld,
} from "./goal-farm-sim";
import { makeFarmStage, type FarmStageOptions } from "./goal-farm-stage";
import { tagLine } from "./goal-farm-tag";
import { planTrip } from "./goal-farm-travel";
import { stationsInUse } from "./goal-farm-use";
import { COORDINATOR_KEY, type WorldAgent } from "./goal-world-agents";

beforeAll(() => {
  // No canvas in jsdom: sprites fall back to plain fills, which is all these tests read.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

const farm = buildFarm();
const VIEW = { x0: 0, x1: farm.width, y0: 0 };
const FRAME = 32;

/** A fixed sequence of rolls, so a farm plays the same way every run. */
function seeded(seed = 11): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const ken = (over: Partial<WorldAgent> = {}): WorldAgent => ({
  key: COORDINATOR_KEY,
  agentName: undefined,
  name: "Ken",
  coordinator: true,
  status: "working",
  kind: "think",
  detail: "Planning",
  ...over,
});
const hand = (key: string, over: Partial<WorldAgent> = {}): WorldAgent => ({
  key,
  agentName: "worker",
  name: "worker",
  coordinator: false,
  status: "working",
  kind: "read",
  detail: "Reading app.ts",
  ...over,
});

/** A canvas context that only remembers which colours were filled and how much was drawn. */
function recorder() {
  const fills = new Set<string>();
  let calls = 0;
  let style = "";
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "fillStyle") return style;
        if (key === "fillRect") {
          return () => {
            calls++;
            fills.add(style);
          };
        }
        if (key === "drawImage") return () => void calls++;
        return () => undefined;
      },
      set: (_target, key, value) => {
        if (key === "fillStyle") style = String(value);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return {
    ctx,
    fills,
    calls: () => calls,
    reset: () => {
      fills.clear();
      calls = 0;
    },
  };
}

/** A farm with its stage, stepped the way GoalWorld's paint loop steps it. */
function setup(options: FarmStageOptions = {}, agents: WorldAgent[] = [ken()]) {
  const world = createFarmWorld(farm, seeded(5));
  const stage = makeFarmStage(() => world, { random: seeded(), ...options });
  const play = createPlay();
  const rec = recorder();
  let now = 0;
  let crew = agents;
  syncFarm(world, crew, now);
  const frame = (): void => {
    now += FRAME;
    stage.before(now);
    stepFarm(world, now);
    stage.draw(rec.ctx, now, play, VIEW);
  };
  return {
    world,
    stage,
    play,
    rec,
    now: () => now,
    frame,
    run(ms: number): void {
      for (const end = now + ms; now < end;) frame();
    },
    /** Step until `done()`; false if it never happens within `limit` ms. */
    until(done: () => boolean, limit: number): boolean {
      for (const end = now + limit; now < end && !done();) frame();
      return done();
    },
    sync(next: WorldAgent[]): void {
      crew = next;
      syncFarm(world, crew, now);
    },
    actor(key: string): Actor {
      const actor = world.actors.get(key);
      if (!actor) throw new Error(`no actor ${key}`);
      return actor;
    },
  };
}

const target = (world: FarmWorld, key: string, now: number): boolean =>
  farmTargets(world, null, now, now).some((t) => t.id === `critter:${key}`);

describe("an actor off the farm for a moment", () => {
  it("keeps its place but isn't stepped, drawn, poked or counted as at work", () => {
    const f = setup({ arrival: "sun", visitors: false }, [ken(), hand("w")]);
    f.run(20_000);
    const w = f.actor("w");
    expect(w.state).toBe("working");
    expect(target(f.world, "w", f.now())).toBe(true);
    expect(stationsInUse(f.world).has(w.station)).toBe(true);
    const rec = recorder();
    const drawn = (): number => {
      rec.reset();
      drawFarm(
        rec.ctx,
        {} as CanvasImageSource,
        f.world,
        f.now(),
        f.now(),
        [],
        null,
        null,
        null,
        null,
      );
      return rec.calls();
    };
    const withIt = drawn();

    w.offstage = true;
    expect(target(f.world, "w", f.now())).toBe(false);
    expect(stationsInUse(f.world).has(w.station)).toBe(false);
    const without = drawn();
    expect(without).toBeLessThan(withIt);
    // Given a new job, it stays put until it's back.
    const spot = w.spot;
    f.sync([ken(), hand("w", { kind: "edit", detail: "Editing app.ts" })]);
    f.run(8000);
    expect(w.spot).toBe(spot);
    expect(w.trip).toBeNull();
    expect(farmIsMoving(f.world)).toBe(false);

    w.offstage = false;
    f.run(FRAME);
    expect(w.state).toBe("moving");
    expect(drawn()).toBeGreaterThan(without);
  });
});

describe("arrivals", () => {
  it("sets a worker down from the saucer, aboard and out of the sim until it lands", () => {
    const f = setup({ arrival: "saucer", visitors: false });
    f.run(1000);
    f.sync([ken(), hand("w")]);
    f.frame();
    const w = f.actor("w");
    expect(w.offstage).toBe(true);
    expect(f.stage.busy()).toBe(true);
    expect(target(f.world, "w", f.now())).toBe(false);

    expect(f.until(() => !w.offstage, 20_000)).toBe(true);
    expect(w.state).not.toBe("arriving");
    // The saucer leaves, and the worker walks to its job like anyone else.
    expect(f.until(() => !f.stage.busy(), 20_000)).toBe(true);
    expect(f.until(() => w.state === "working", 40_000)).toBe(true);
    expect(w.station).toBe("bookcase");
  });

  it("walks a worker in from off the edge of the map", () => {
    const f = setup({ arrival: "walk", visitors: false });
    f.run(1000);
    f.sync([ken(), hand("w")]);
    f.frame();
    const w = f.actor("w");
    expect(w.trip?.from.x ?? w.spot.x).toBeLessThan(0);
    expect(f.stage.busy()).toBe(false);
    expect(f.until(() => w.state === "working", 60_000)).toBe(true);
    expect(w.spot.x).toBeGreaterThan(0);
  });

  it("leaves the gate's sunlight alone when that's how they come", () => {
    const f = setup({ arrival: "sun", visitors: false });
    f.run(1000);
    f.sync([ken(), hand("w")]);
    f.frame();
    expect(f.actor("w").state).toBe("arriving");
    expect(f.actor("w").offstage).toBeFalsy();
    expect(f.stage.busy()).toBe(false);
  });
});

describe("exits", () => {
  const staged = FARM_EXITS.filter((exit) => exit !== "sun");

  it.each(staged)("%s takes a finished worker off the farm and plays it out", (exit: FarmExit) => {
    const f = setup({ arrival: "sun", exit, visitors: false }, [ken(), hand("w")]);
    f.run(20_000);
    f.sync([ken(), hand("w", { status: "done", kind: null })]);
    // Off the sim's hands (at once, or at the gate), and the stage is playing it.
    expect(f.until(() => !f.world.actors.has("w"), 60_000)).toBe(true);
    expect(f.stage.busy()).toBe(true);
    f.rec.reset();
    f.frame();
    expect(f.rec.calls()).toBeGreaterThan(0);
    expect(f.until(() => !f.stage.busy(), 60_000)).toBe(true);
    // And then nothing is left to draw.
    f.rec.reset();
    f.frame();
    expect(f.rec.calls()).toBe(0);
  });

  it("lets a failed worker go the plain way, whatever the stage had planned", () => {
    const f = setup({ arrival: "sun", exit: "saucer", visitors: false }, [ken(), hand("w")]);
    f.run(20_000);
    f.sync([ken(), hand("w", { status: "error", kind: null })]);
    let staged = false;
    expect(
      f.until(() => {
        staged ||= f.stage.busy();
        return !f.world.actors.has("w");
      }, 60_000),
    ).toBe(true);
    expect(staged).toBe(false);
  });
});

describe("visitors", () => {
  const crew = [ken(), hand("a"), hand("b", { kind: "edit", detail: "Editing app.ts" })];

  it("powers little Ken up for the fight, and puts him back when it's won", () => {
    const f = setup({ arrival: "sun", exit: "sun", visitors: ["ken"] }, crew);
    const little = f.actor(COORDINATOR_KEY);
    const said = new Set<string>();
    const listen = (): void => {
      for (const key of ["a", "b"]) {
        const text = f.actor(key).bubble?.text;
        if (text) said.add(text);
      }
    };
    // The monster comes up the road first; then Ken steps out of the farm.
    expect(f.until(() => f.stage.busy(), 30_000)).toBe(true);
    expect(little.offstage).toBeFalsy();
    const spot = little.spot;
    expect(
      f.until(() => {
        listen();
        return little.offstage === true;
      }, 30_000),
    ).toBe(true);
    expect(said.has("!")).toBe(true);
    expect(target(f.world, COORDINATOR_KEY, f.now())).toBe(false);

    // He always wins: the fight ends, the crew cheers, and he's back where he was.
    expect(
      f.until(() => {
        listen();
        return !f.stage.busy();
      }, 60_000),
    ).toBe(true);
    expect([...said].some((line) => ["KEN!", "GG!", "Woo!", "Yay!"].includes(line))).toBe(true);
    expect(little.offstage).toBe(false);
    expect(little.spot).toBe(spot);
    expect(target(f.world, COORDINATOR_KEY, f.now())).toBe(true);
    f.rec.reset();
    f.frame();
    expect(f.rec.calls()).toBe(0);
  });

  it("never starts one while GG Goals is asking, walking, or a sign is up", () => {
    let sign = true;
    const f = setup({ visitors: ["ken"], quiet: () => sign }, crew);
    f.run(60_000);
    expect(f.stage.busy()).toBe(false);

    // The sign comes down, but now he's asking the user something.
    sign = false;
    f.sync([ken({ kind: "ask", detail: "Asking you" }), ...crew.slice(1)]);
    f.run(60_000);
    expect(f.stage.busy()).toBe(false);

    // Answered, and off on a walk: still not now.
    f.sync(crew);
    const little = f.actor(COORDINATOR_KEY);
    for (let t = 0; t < 60_000; t += FRAME) {
      little.trip ??= planTrip([little.spot, { x: little.spot.x + 30, y: little.spot.y }], {
        now: f.now(),
      });
      f.frame();
      expect(little.offstage).toBeFalsy();
    }
  });

  it("cuts a fight short when a question goes up, with Ken back at once", () => {
    let sign = false;
    const f = setup({ visitors: ["ken"], quiet: () => sign }, crew);
    const little = f.actor(COORDINATOR_KEY);
    expect(f.until(() => little.offstage === true, 60_000)).toBe(true);
    sign = true;
    f.frame();
    expect(little.offstage).toBe(false);
    expect(f.stage.busy()).toBe(false);
  });

  it.each(["flyover", "monster"] as const)("%s comes, and goes without a trace", (visitor) => {
    const f = setup({ visitors: [visitor] }, crew);
    expect(f.until(() => f.stage.busy(), 30_000)).toBe(true);
    expect(f.until(() => !f.stage.busy(), 60_000)).toBe(true);
    expect(f.actor(COORDINATOR_KEY).offstage).toBeFalsy();
    f.rec.reset();
    f.frame();
    expect(f.rec.calls()).toBe(0);
  });

  it("keeps away when visitors are off", () => {
    const f = setup({ visitors: false }, crew);
    f.run(120_000);
    expect(f.stage.busy()).toBe(false);
  });
});

describe("the name tag", () => {
  const GOLD = "#e9af54";
  const tagged = (f: ReturnType<typeof setup>, play: FarmPlay, tagOnly = false): boolean => {
    f.rec.reset();
    f.stage.draw(f.rec.ctx, f.now(), play, VIEW, tagOnly);
    return f.rec.fills.has(GOLD);
  };

  it("says what the worker's agent is doing, with the tool's icon", () => {
    const f = setup({ arrival: "sun", visitors: false }, [ken(), hand("w")]);
    f.run(20_000);
    expect(tagLine(f.actor("w"))).toEqual({ text: "Reading app.ts", icon: "read" });
    f.sync([ken(), hand("w", { kind: null, detail: "" })]);
    f.run(FRAME);
    expect(tagLine(f.actor("w"))).toEqual({ text: "On the move", icon: "idle" });
  });

  it("shows for the critter under the pointer, or for a moment after a click", () => {
    const f = setup({ arrival: "sun", visitors: false }, [ken(), hand("w")]);
    f.run(20_000);
    expect(tagged(f, f.play)).toBe(false);
    f.play.hovered = "critter:w";
    expect(tagged(f, f.play)).toBe(true);
    // Reduced motion keeps the tag (and only the tag).
    expect(tagged(f, f.play, true)).toBe(true);
    f.play.hovered = "well";
    expect(tagged(f, f.play)).toBe(false);

    f.play.hovered = null;
    f.stage.pin("w", f.now());
    expect(tagged(f, f.play)).toBe(true);
    f.run(3000);
    expect(tagged(f, f.play)).toBe(false);

    // Nobody off the farm wears one.
    f.play.hovered = "critter:w";
    f.actor("w").offstage = true;
    expect(tagged(f, f.play)).toBe(false);
  });
});
