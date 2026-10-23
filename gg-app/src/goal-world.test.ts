import { describe, expect, it } from "vitest";
import type { FloorAgent } from "./critter-floor";
import {
  COORDINATOR_KEY,
  collectWorldAgents,
  coordinatorKind,
  previewCrowd,
  type WorldAgent,
} from "./goal-world-agents";
import { STATION_FOR, STATION_KINDS } from "./goal-world-stations";
import { goalFinishOf, goalIsQuiet, openStretch, type GoalRun } from "./goal-finish";
import type { CritterGroup } from "./CritterFloor";
import {
  FARM_CRITTERS,
  FARM_CRITTER_H,
  FARM_CRITTER_W,
  KEN_FARM_CRITTER,
  farmCritterLook,
  pickFarmCritter,
} from "./goal-farm-critters";
import { fireTop } from "./goal-map-topdown";
import { FARM_CORE, SURFACE, buildFarm, type Farm, type Rect } from "./goal-farm-map";
import {
  ARRIVE_MS,
  LEAVE_MS,
  MIN_WORK_MS,
  createFarmWorld,
  resizeFarm,
  spotAt,
  stepFarm,
  syncFarm,
} from "./goal-farm-sim";
import {
  TRAVEL_MODES,
  chooseMode,
  createRouter,
  pathLength,
  planTrip,
  tripPose,
} from "./goal-farm-travel";
import { composeMap } from "./goal-map-compose";
import {
  FARM_TIMES,
  blendLook,
  farmSkyAt,
  gradePixel,
  lightRelief,
  litPatch,
  skyLight,
  skyOverlay,
  weatherFor,
  weatherLook,
} from "./goal-farm-sky";
import { coverAt, coverStep, weatherBackground } from "./goal-farm-weather";
import {
  LIGHTS,
  REACTIONS,
  animalClock,
  createPlay,
  playing,
  poke,
  reactionOn,
  settlePlay,
} from "./goal-farm-interact";
import {
  STATION_USES,
  playUses,
  stationThings,
  stationsInUse,
  usesNeedPace,
} from "./goal-farm-use";
import {
  drawFarm,
  paintSwayBase,
  swaySurface,
  farmTargets,
  litLamps,
  nearestWater,
  spawnDebris,
  targetAt,
} from "./goal-farm-render";
import { PixelBuffer } from "./goal-map-pixels";
import { TILE } from "./goal-map-ground";
import { BODY, SolidMask, planRoute, roamPose } from "./goal-farm-roam";

const farm = buildFarm();

/** A fixed sequence of draws, so the farm replays the same way every run. */
function draws(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
}

const worker = (over: Partial<FloorAgent> = {}): FloorAgent => ({
  key: "g1:t1",
  agentName: "researcher",
  label: "Researcher",
  status: "running",
  activity: "Reading src/app.ts",
  tokens: "",
  durationMs: 0,
  toolUseCount: 1,
  ...over,
});

const coordinatorAgent = (over: Partial<WorldAgent> = {}): WorldAgent => ({
  key: COORDINATOR_KEY,
  agentName: undefined,
  name: "GG Goals",
  coordinator: true,
  status: "working",
  kind: "think",
  detail: "Planning",
  ...over,
});

const inside = (r: Rect, x: number, y: number): boolean =>
  x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;

/** Does the segment from a to b pass through any obstacle? (Sampled every 2px.) */
function crosses(f: Farm, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const y = a.y + ((b.y - a.y) * i) / steps;
    if (f.obstacles.some((r) => inside(r, x, y))) return true;
  }
  return false;
}

describe("goal world agents", () => {
  it("puts GG Goals first and reads its work from the live tool feed", () => {
    const agents = collectWorldAgents({
      running: true,
      waitingOnUser: false,
      liveTools: [
        { id: "a", name: "read", args: { file_path: "/x/a.ts" }, status: "done" },
        { id: "b", name: "web_search", args: { query: "seo 2026" }, status: "running" },
      ] as never,
      workers: [worker()],
    });
    expect(agents.map((a) => a.key)).toEqual([COORDINATOR_KEY, "g1:t1"]);
    expect(agents[0]).toMatchObject({ kind: "web", detail: "Browsing seo 2026" });
    expect(agents[1]).toMatchObject({ kind: "read", status: "working" });
  });

  it("shows GG Goals at the mailbox while it waits on the user, and resting when idle", () => {
    const base = { liveTools: [], workers: [] };
    expect(collectWorldAgents({ ...base, running: true, waitingOnUser: true })[0]?.kind).toBe(
      "ask",
    );
    expect(collectWorldAgents({ ...base, running: false, waitingOnUser: false })[0]).toMatchObject({
      status: "idle",
      kind: null,
    });
  });

  it("keeps GG Goals where its last work was between tool calls, not pacing to the notes board", () => {
    // Regression: every gap between tool calls sent Ken to the notes board,
    // so a run of reads had him walking board, bookcase, board, bookcase.
    const base = { running: true, waitingOnUser: false, workers: [] };
    const atStart = collectWorldAgents({ ...base, liveTools: [] })[0];
    expect(atStart).toMatchObject({ kind: "think", detail: "Planning" });
    const afterRead = collectWorldAgents({
      ...base,
      liveTools: [{ id: "a", name: "read", args: {}, status: "done" }] as never,
    })[0];
    expect(afterRead).toMatchObject({ kind: "read", detail: "Planning" });
    // An answered question doesn't keep him at the mailbox.
    const afterAsk = collectWorldAgents({
      ...base,
      liveTools: [{ id: "b", name: "ask_user", args: {}, status: "done" }] as never,
    })[0];
    expect(afterAsk?.kind).toBe("think");
  });

  it("maps orchestration tools to orchestration work", () => {
    expect(coordinatorKind("spawn_agent")).toBe("delegate");
    expect(coordinatorKind("wait_agent")).toBe("wait");
    expect(coordinatorKind("ask_user")).toBe("ask");
    expect(coordinatorKind("edit")).toBe("edit");
    expect(coordinatorKind("some_mcp_tool")).toBe("think");
  });

  it("marks finished and failed workers so they leave", () => {
    const agents = collectWorldAgents({
      running: false,
      waitingOnUser: false,
      liveTools: [],
      workers: [worker({ status: "done" }), worker({ key: "g1:t2", status: "error" })],
    });
    expect(agents.slice(1).map((a) => [a.status, a.kind])).toEqual([
      ["done", null],
      ["error", null],
    ]);
  });
});

describe("goal farm critters", () => {
  it("draws GG Goals as a little Ken, the farm's size, and never hands Ken to a worker", () => {
    expect(KEN_FARM_CRITTER.rows).toHaveLength(FARM_CRITTER_H);
    for (const row of KEN_FARM_CRITTER.rows) expect(row).toHaveLength(FARM_CRITTER_W);
    for (const ch of new Set(KEN_FARM_CRITTER.rows.join(""))) {
      if (ch !== ".") expect(KEN_FARM_CRITTER.palette[ch], ch).toBeDefined();
    }
    expect(farmCritterLook("ken")).toBe(KEN_FARM_CRITTER);
    expect(FARM_CRITTERS.some((c) => c.id === "ken")).toBe(false);
    const none = new Set<string>();
    for (let i = 0; i < 60; i++)
      expect(pickFarmCritter(undefined, `w${i}`, none).id).not.toBe("ken");
  });

  it("gives each member of GG Goals' team a critter of its own", () => {
    const none = new Set<string>();
    expect(
      ["builder", "scout", "researcher", "checker"].map(
        (name) => pickFarmCritter(name, name, none).id,
      ),
    ).toEqual(["tanuki", "squirrel", "owl", "hedgehog"]);
  });
});

describe("goal farm map", () => {
  it("keeps the animals' bodies off the buildings, trees, bushes and stove", () => {
    // What an animal mustn't stand on: the drawn pixels of everything
    // standing (buildings, benches, the stove, trees, bushes, lanterns),
    // since the map is painted under the animals and they can't pass behind
    // it. Only low grass and flowers (14px or shorter) may be walked through.
    const solid = farm.scene.props.filter((p) => !p.flat && p.sprite.buf.height > 14);
    // Is a map pixel covered by one of those props' drawn pixels?
    const drawnAt = (x: number, y: number): boolean =>
      solid.some((p) => {
        const { buf, ax, ay } = p.sprite;
        const left = Math.floor(p.x) - (p.flip ? buf.width - 1 - ax : ax);
        const sx = x - left;
        return buf.opaque(p.flip ? buf.width - 1 - sx : sx, y - (Math.floor(p.y) - ay));
      });
    // A body box standing on its feet at (x, y), as big as the drawn animals.
    const clear = (x: number, y: number, w: number, h: number): boolean => {
      const hitsFootprint = farm.obstacles.some(
        (r) => x + w / 2 > r.x && x - w / 2 < r.x + r.w && y > r.y && y - h < r.y + r.h,
      );
      if (hitsFootprint) return false;
      for (let py = Math.floor(y - h); py <= Math.floor(y); py++) {
        for (let px = Math.floor(x - w / 2); px < Math.ceil(x + w / 2); px++) {
          if (drawnAt(px, py)) return false;
        }
      }
      return true;
    };
    // A spot on the stove's top is caught.
    expect(clear(farm.origin.x + 472, farm.origin.y + 134, 14, 12)).toBe(false);
    // Every animal actually wanders (more than one stop), and at no moment
    // of its loop does its body touch a building, the bench or the stove.
    expect(farm.ambient.roamers.length).toBeGreaterThan(2);
    for (const roamer of farm.ambient.roamers) {
      expect(roamer.route.length).toBeGreaterThan(2);
      const { w, h } = BODY[roamer.kind];
      for (let t = 0; t < 90; t += 0.5) {
        const pose = roamPose(roamer, t);
        expect(clear(pose.x, pose.y, w, h)).toBe(true);
      }
    }
  });

  it("sends browser and screenshot tools to the laptop, other unknown tools to the notes board", () => {
    const kindOf = (activity: string): WorldAgent["kind"] =>
      collectWorldAgents({
        running: true,
        liveTools: [],
        waitingOnUser: false,
        workers: [worker({ activity })],
      })[1]?.kind ?? null;
    expect(kindOf("mcp__playwright__browser_navigate: https://example.com")).toBe("web");
    expect(kindOf("take_screenshot")).toBe("web");
    expect(kindOf("mcp__chrome__click: #submit")).toBe("web");
    expect(kindOf("mcp__postgres__query: select 1")).toBe("think");
    expect(kindOf("Reading src/app.ts")).toBe("read");
    expect(coordinatorKind("mcp__playwright__browser_snapshot")).toBe("web");
  });

  it("moves a worker to the place for whatever tool it's using right now", () => {
    const world = createFarmWorld(farm, draws(0.5));
    let t = 0;
    // Run the farm until the worker has arrived and settled at its station.
    const settleOn = (activity: string): ReturnType<typeof world.actors.get> => {
      const agents = collectWorldAgents({
        running: true,
        liveTools: [],
        waitingOnUser: false,
        workers: [worker({ activity })],
      });
      for (let i = 0; i < 200; i++, t += 100) {
        syncFarm(world, agents, t);
        stepFarm(world, t);
      }
      return world.actors.get("g1:t1");
    };
    const steps: ReadonlyArray<readonly [string, string]> = [
      ["Reading src/app.ts", "bookcase"],
      ["Searching web for pixel art", "computer"],
      ["Searching for \u201cfarmScale\u201d", "maptable"],
      ["Editing src/GoalWorld.tsx", "workbench"],
      ["Running pnpm test", "machine"],
      ["Fetching https://example.com", "computer"],
    ];
    for (const [activity, station] of steps) {
      const critter = settleOn(activity);
      expect(critter?.station, activity).toBe(station);
      expect(critter?.state, activity).toBe("working");
      expect(critter?.trip, activity).toBeNull();
      // It stands at one of that station's spots, facing what it's using.
      const spots = farm.stations[station as keyof typeof farm.stations];
      expect(spots.some((s) => s.x === critter?.spot.x && s.y === critter.spot.y)).toBe(true);
      const look = farm.lookAt[station as keyof typeof farm.lookAt];
      if (critter && Math.abs(look.x - critter.spot.x) > 2) {
        expect(critter.facing).toBe(look.x > critter.spot.x ? 1 : -1);
      }
    }
  });

  it("walks a worker off the farm when its task is done, and back in for a follow-up", () => {
    // Live run: a worker reports "idle" when its task is finished (kept for
    // follow-ups), and it stayed standing on the farm as if still there.
    const world = createFarmWorld(farm, draws(0.5));
    let t = 0;
    const run = (status: FloorAgent["status"], ms: number): void => {
      const agents = collectWorldAgents({
        running: true,
        liveTools: [],
        waitingOnUser: false,
        workers: [worker({ status })],
      });
      for (const end = t + ms; t < end; t += 100) {
        syncFarm(world, agents, t);
        stepFarm(world, t);
      }
    };
    run("running", 20_000);
    expect(world.actors.get("g1:t1")?.state).toBe("working");
    run("idle", 60_000);
    expect(world.actors.has("g1:t1")).toBe(false);
    // GG Goals hands it another task: it comes back in and gets to work.
    run("running", 30_000);
    expect(world.actors.get("g1:t1")?.state).toBe("working");
  });

  it("never stands two critters on top of each other, even with a big crowd", () => {
    const world = createFarmWorld(farm, () => 0.37);
    for (let t = 0; t <= 60000; t += 100) {
      syncFarm(world, previewCrowd(t), t);
      stepFarm(world, t);
      if (t % 1000 !== 0) continue;
      const standing = [...world.actors.values()].filter((a) => !a.trip && a.state !== "leaving");
      for (let i = 0; i < standing.length; i++) {
        for (let j = 0; j < i; j++) {
          const a = standing[i]?.spot ?? { x: 0, y: 0 };
          const b = standing[j]?.spot ?? { x: 0, y: 0 };
          // A critter is 14 wide and 15 tall: any closer and their bodies overlap.
          expect(Math.abs(a.x - b.x) >= 14 || Math.abs(a.y - b.y) >= 15).toBe(true);
        }
      }
    }
  });

  it("pours the bamboo spout onto open water, not onto the stones", () => {
    const { mouth, pour } = farm.ambient.spout;
    expect(mouth.y).toBeLessThan(pour.y);
    expect(Math.abs(mouth.x - pour.x)).toBeLessThanOrEqual(2);
    // Round where it lands (where the ripples spread) is pond water: teal or
    // foam, greener than it is red (unlike the grey stones or the bamboo) and
    // with nearly as much blue as green (unlike grass).
    const map = composeMap(farm.scene);
    for (let dy = 0; dy <= 2; dy++) {
      for (let dx = -4; dx <= 5; dx++) {
        const c = map.rgb(pour.x + dx, pour.y + dy);
        const r = (c >> 16) & 255;
        const g = (c >> 8) & 255;
        const b = c & 255;
        expect(g > r && g - b < 60, `(${dx}, ${dy}) is #${c.toString(16)}`).toBe(true);
      }
    }
  });

  it("plans wandering loops that never cross anything solid", () => {
    // A 100×60 yard with a block in the middle.
    const mask = new SolidMask(100, 60, (x, y) => x >= 40 && x < 60 && y >= 20 && y < 40);
    const route = planRoute(mask, "hen", { x: 20, y: 50 }, 80, 7);
    expect(route.length).toBeGreaterThan(2);
    for (let i = 0; i < route.length; i++) {
      const a = route[i] ?? { x: 0, y: 0 };
      const b = route[(i + 1) % route.length] ?? a;
      expect(mask.walkable("hen", a, b)).toBe(true);
    }
    // A blocked home moves to the nearest clear spot, and the hen still wanders.
    const moved = planRoute(mask, "hen", { x: 50, y: 39 }, 80, 7);
    expect(moved.length).toBeGreaterThan(2);
    for (const spot of moved) expect(mask.clear("hen", spot.x, spot.y)).toBe(true);
    // Nowhere clear in reach: no route, so it isn't placed on top of things.
    const walled = new SolidMask(30, 30, () => true);
    expect(planRoute(walled, "hen", { x: 15, y: 15 }, 10, 7)).toHaveLength(0);
  });

  it("has a place for every kind of work, inside the map and clear of the buildings", () => {
    for (const kind of STATION_KINDS) {
      const spots = farm.stations[kind];
      expect(spots.length).toBeGreaterThan(0);
      for (const spot of spots) {
        expect(spot.x).toBeGreaterThan(0);
        expect(spot.y).toBeGreaterThan(0);
        expect(spot.x).toBeLessThan(farm.width);
        expect(spot.y).toBeLessThan(farm.height);
        expect(farm.obstacles.some((r) => inside(r, spot.x, spot.y))).toBe(false);
      }
    }
    for (const station of Object.values(STATION_FOR)) {
      expect(farm.stations[station].length).toBeGreaterThan(0);
    }
  });

  it("lays its walkways around the house, the pond, the trees and the fields", () => {
    for (const [a, b] of farm.paths.edges) {
      const na = farm.paths.nodes[a];
      const nb = farm.paths.nodes[b];
      if (!na || !nb) throw new Error(`edge ${a}-${b} has a missing node`);
      expect(crosses(farm, na, nb), `walkway ${a}-${b}`).toBe(false);
    }
  });

  it("joins every place to every other, so nobody gets stuck", () => {
    const router = createRouter(farm.paths);
    const spots = STATION_KINDS.map((kind) => farm.stations[kind][0]).filter(
      (s) => s !== undefined,
    );
    for (const from of spots) {
      for (const to of spots) {
        const route = router.route(from, to);
        expect(route[0]).toEqual(from);
        expect(route[route.length - 1]).toEqual(to);
      }
    }
  });

  it("keeps the farmstead whole, centred below the header, on any bigger map", () => {
    const big = buildFarm({ cols: 44, rows: 28, top: 3 });
    expect([big.width, big.height]).toEqual([44 * TILE, 28 * TILE]);
    expect(big.origin.x).toBe(Math.floor((44 - FARM_CORE.cols) / 2) * TILE);
    expect(big.origin.y).toBeGreaterThanOrEqual(3 * TILE);
    expect(big.origin.y + FARM_CORE.rows * TILE).toBeLessThanOrEqual(big.height);
    // Everything about the farmstead moved with it.
    const shift = { x: big.origin.x - farm.origin.x, y: big.origin.y - farm.origin.y };
    const gate = farm.stations.door[0];
    expect(big.stations.door[0]).toEqual(gate && { x: gate.x + shift.x, y: gate.y + shift.y });
    // A map smaller than the farmstead is grown to fit it.
    const tiny = buildFarm({ cols: 10, rows: 8 });
    expect([tiny.width, tiny.height]).toEqual([FARM_CORE.cols * TILE, FARM_CORE.rows * TILE]);
  });
});

describe("goal farm travel", () => {
  it("walks short trips and jogs long ones, on foot only", () => {
    expect(chooseMode(20)).toBe("walk");
    expect(chooseMode(120)).toBe("walk");
    expect(chooseMode(300)).toBe("run");
    expect(TRAVEL_MODES).toEqual(["walk", "run"]);
  });

  it("moves smoothly: never more than a step between frames, easing in and out", () => {
    const router = createRouter(farm.paths);
    const spots = STATION_KINDS.map((kind) => farm.stations[kind][0]).filter(
      (s) => s !== undefined,
    );
    for (const from of spots) {
      for (const to of spots) {
        if (from === to) continue;
        const trip = planTrip(router.route(from, to), { now: 0 });
        // At 30fps a critter never covers more than ~2px a frame: no jumps.
        let prev = tripPose(trip, 0);
        const steps: number[] = [];
        for (let t = 33; t <= trip.duration; t += 33) {
          const pose = tripPose(trip, t);
          const step = Math.hypot(pose.x - prev.x, pose.y - prev.y);
          expect(step).toBeLessThan(2.2);
          steps.push(step);
          prev = pose;
        }
        // It sets off and arrives slower than it travels.
        const cruise = Math.max(...steps);
        expect(steps[0] ?? 0).toBeLessThan(cruise);
        expect(steps[steps.length - 1] ?? 0).toBeLessThan(cruise);
      }
    }
  });

  it("ends every trip exactly where it was headed", () => {
    const router = createRouter(farm.paths);
    const from = farm.stations.door[0] ?? farm.origin;
    const to = farm.stations.machine[0] ?? farm.origin;
    const trip = planTrip(router.route(from, to), { now: 1000 });
    const end = tripPose(trip, 1000 + trip.duration);
    expect(end.done).toBe(true);
    expect([end.x, end.y]).toEqual([to.x, to.y]);
  });

  it("never walks a critter through anything standing on the ground", () => {
    // Regression: critters spawning in walked straight through the laptop
    // desk (the walkways only kept clear of a hand-drawn list of rectangles).
    const router = createRouter(farm.paths, farm.walk);
    const { walk } = farm;
    const feetBlocked = (x: number, y: number): boolean => {
      for (let yy = Math.round(y) - 1; yy <= Math.round(y); yy++) {
        for (let xx = Math.round(x) - 3; xx <= Math.round(x) + 3; xx++) {
          if (walk.blocked[yy * walk.width + xx]) return true;
        }
      }
      return false;
    };
    // Every standing spot is on clear ground.
    const all = [...Object.values(farm.stations).flat(), farm.paths.nodes[0] ?? farm.origin];
    for (const spot of all) expect(feetBlocked(spot.x, spot.y)).toBe(false);
    // Routes between a spread of them (two per station, and the gate).
    const spots = [
      ...Object.values(farm.stations).flatMap((slots) => slots.filter((_, i) => i % 4 === 0)),
      farm.paths.nodes[0] ?? farm.origin,
    ];
    let checked = 0;
    for (const from of spots) {
      for (const to of spots) {
        if (from === to) continue;
        const route = router.route(from, to);
        expect(route[0]).toEqual(from);
        expect(route[route.length - 1]).toEqual(to);
        for (let i = 1; i < route.length; i++) {
          const a = route[i - 1];
          const b = route[i];
          if (!a || !b) continue;
          const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
          for (let k = 1; k < steps; k++) {
            const x = a.x + ((b.x - a.x) * k) / steps;
            const y = a.y + ((b.y - a.y) * k) / steps;
            expect(feetBlocked(x, y), `${from.x},${from.y} to ${to.x},${to.y}`).toBe(false);
          }
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
    // The desk's own ground is blocked: a straight line through it isn't walkable.
    const desk = farm.things.find((t) => t.kind === "laptop");
    if (!desk) throw new Error("no laptop desk");
    expect(feetBlocked(desk.x + desk.buf.width / 2, desk.base - 3)).toBe(true);
  });

  it("follows the walkways instead of cutting across the yard", () => {
    const router = createRouter(farm.paths);
    const route = router.route(
      farm.stations.door[0] ?? farm.origin,
      farm.stations.workbench[0] ?? farm.origin,
    );
    expect(route.length).toBeGreaterThan(3);
    for (let i = 2; i < route.length - 1; i++) {
      const a = route[i - 1];
      const b = route[i];
      if (a && b) expect(crosses(farm, a, b)).toBe(false);
    }
    expect(pathLength(route)).toBeGreaterThan(0);
  });
});

describe("goal farm life", () => {
  it("places agents already at work on the first sync instead of walking them in", () => {
    const world = createFarmWorld(farm, draws(0.5));
    syncFarm(
      world,
      [coordinatorAgent(), { ...coordinatorAgent(), key: "w", coordinator: false, kind: "read" }],
      0,
    );
    const placed = world.actors.get("w");
    expect(placed?.state).toBe("working");
    expect(placed?.station).toBe("bookcase");
    expect(placed?.spot).toEqual(farm.stations.bookcase[0]);
    // GG Goals is a little Ken, never one of the workers' critters.
    expect(world.actors.get(COORDINATOR_KEY)?.critterId).toBe("ken");
    expect(placed?.critterId).not.toBe("ken");
  });

  it("walks a new worker in through the gate, to its station, and out again when done", () => {
    const world = createFarmWorld(farm, draws(0.1, 0.7, 0.4));
    syncFarm(world, [coordinatorAgent({ kind: "delegate" })], 0);
    // Ken turns from bringing in help back to planning as the newcomer comes
    // in, and says nothing about it (a high roll), so the newcomer's own roll
    // is the next one: low, a hello.
    const rolls = [0.9, 0.1, 0.7, 0.4];
    let roll = 0;
    (world as { random: () => number }).random = () => rolls[roll++ % rolls.length] ?? 0;
    const newcomer: WorldAgent = {
      key: "w1",
      agentName: "worker",
      name: "Worker",
      coordinator: false,
      status: "working",
      kind: "edit",
      detail: "Editing",
    };
    syncFarm(world, [coordinatorAgent(), newcomer], 100);
    const actor = world.actors.get("w1");
    expect(actor?.state).toBe("arriving");
    expect(actor?.station).toBe("door");
    // A low roll (0.1): this one says hello.
    expect(actor?.bubble?.text).toBeTruthy();

    // Steps in, walks over, and gets to work at the carpenter's bench.
    let now = 100;
    for (; now < 100 + ARRIVE_MS + 20000 && actor?.state !== "working"; now += 16) {
      stepFarm(world, now);
    }
    expect(actor?.station).toBe("workbench");
    expect(actor?.state).toBe("working");

    // Finished: back to the gate, says goodbye, and is gone.
    syncFarm(world, [coordinatorAgent(), { ...newcomer, status: "done", kind: null }], now);
    for (const end = now + MIN_WORK_MS + 20000 + LEAVE_MS; now < end; now += 16) {
      stepFarm(world, now);
      if (!world.actors.has("w1")) break;
    }
    expect(world.actors.has("w1")).toBe(false);
    expect(world.actors.has(COORDINATOR_KEY)).toBe(true);
  });

  it("greets only now and then: never on a high roll, never twice in quick succession", () => {
    const newcomer = (key: string): WorldAgent => ({
      key,
      agentName: undefined,
      name: key,
      coordinator: false,
      status: "working",
      kind: "read",
      detail: "Reading",
    });
    // A high roll: arrives without a word.
    const quiet = createFarmWorld(farm, draws(0.9));
    syncFarm(quiet, [coordinatorAgent()], 0);
    syncFarm(quiet, [coordinatorAgent(), newcomer("a")], 100);
    expect(quiet.actors.get("a")?.bubble).toBeNull();
    // Low rolls every time: the first says hello, the next ones (moments later) don't.
    const chatty = createFarmWorld(farm, draws(0.1));
    syncFarm(chatty, [coordinatorAgent()], 0);
    syncFarm(chatty, [coordinatorAgent(), newcomer("a")], 100);
    syncFarm(chatty, [coordinatorAgent(), newcomer("a"), newcomer("b")], 400);
    syncFarm(chatty, [coordinatorAgent(), newcomer("a"), newcomer("b"), newcomer("c")], 900);
    expect(chatty.actors.get("a")?.bubble).not.toBeNull();
    expect(chatty.actors.get("b")?.bubble).toBeNull();
    expect(chatty.actors.get("c")?.bubble).toBeNull();
  });

  it("stays at a station long enough to be seen working before moving on", () => {
    const world = createFarmWorld(farm, draws(0.5));
    const agent = { ...coordinatorAgent(), key: "w", coordinator: false, kind: "read" as const };
    syncFarm(world, [coordinatorAgent(), agent], 0);
    syncFarm(world, [coordinatorAgent(), { ...agent, kind: "edit" }], 10);
    stepFarm(world, 20);
    expect(world.actors.get("w")?.station).toBe("bookcase");
    stepFarm(world, MIN_WORK_MS + 50);
    expect(world.actors.get("w")?.station).toBe("workbench");
  });

  it("jumps straight to the end state when motion is off", () => {
    const world = createFarmWorld(farm, draws(0.5));
    syncFarm(world, [coordinatorAgent({ kind: "web" })], 0);
    syncFarm(world, [coordinatorAgent({ kind: "read" })], 5);
    stepFarm(world, 10, true);
    const coordinator = world.actors.get(COORDINATOR_KEY);
    expect(coordinator?.trip).toBeNull();
    expect(coordinator?.station).toBe("bookcase");
    expect(coordinator?.spot).toEqual(farm.stations.bookcase[0]);
    expect(coordinator?.state).toBe("working");
  });

  it("gives crowded stations a place for everyone", () => {
    const seen = new Set<string>();
    for (let slot = 0; slot < 12; slot++) {
      const spot = spotAt(farm, "lounge", slot);
      seen.add(`${spot.x},${spot.y}`);
    }
    expect(seen.size).toBe(12);
  });

  it("keeps everyone at their stations through a resize, wherever the farmstead moves", () => {
    const world = createFarmWorld(farm, draws(0.5));
    syncFarm(world, [coordinatorAgent({ kind: "read" })], 0);
    const bigger = buildFarm({ cols: 40, rows: 26 });
    resizeFarm(world, bigger);
    const coordinator = world.actors.get(COORDINATOR_KEY);
    expect(coordinator?.spot).toEqual(bigger.stations.bookcase[0]);
    expect(coordinator?.trip).toBeNull();
  });
});

describe("goal farm sky", () => {
  it("is plain daylight at lunch and darkest at night, with the lamps lit after dark", () => {
    const lunch = farmSkyAt(12.5);
    expect(lunch.tintAlpha).toBe(0);
    expect(lunch.lamps).toBe(0);
    const night = farmSkyAt(23);
    expect(night.tintAlpha).toBeGreaterThan(0.5);
    expect(night.lamps).toBe(1);
    expect(night.fireflies).toBe(1);
    // Every preview moment has a look, and the light changes gradually across the day.
    for (const time of FARM_TIMES) expect(farmSkyAt(time.hour).tintAlpha).toBeLessThan(0.7);
    for (let h = 0; h < 24; h += 0.25) {
      const step = Math.abs(farmSkyAt(h + 0.25).tintAlpha - farmSkyAt(h).tintAlpha);
      // Never more than a gentle shift in a quarter of an hour (dawn is the quickest).
      expect(step).toBeLessThan(0.12);
    }
  });

  it("chooses the same weather for everyone at the same time, with snow only in winter", () => {
    const at = (y: number, m: number, d: number, h: number): Date => new Date(y, m, d, h);
    expect(weatherFor(at(2026, 6, 4, 10))).toBe(weatherFor(at(2026, 6, 4, 11)));
    const seen = new Set<string>();
    for (let d = 1; d <= 28; d++) {
      for (const h of [2, 6, 10, 14, 18, 22]) {
        const summer = weatherFor(at(2026, 6, d, h));
        expect(summer).not.toBe("snow");
        seen.add(summer);
        expect(weatherFor(at(2026, 0, d, h))).not.toBe("rain");
      }
    }
    // Mostly fair, but it does change.
    expect(seen.has("clear")).toBe(true);
    expect(seen.size).toBeGreaterThan(2);
  });

  it("gives morning, lunch and afternoon each their own look, with dawn's lavender in the shadows", () => {
    const morning = farmSkyAt(8.2);
    const lunch = farmSkyAt(12.5);
    const afternoon = farmSkyAt(15.5);
    const graded = (sky: ReturnType<typeof farmSkyAt>): string =>
      gradePixel(120, 140, 90, sky).join(",") + "|" + gradePixel(40, 50, 30, sky).join(",");
    expect(new Set([graded(morning), graded(lunch), graded(afternoon)]).size).toBe(3);
    // Every daytime shadow leans blue-violet (more blue than red), like dawn's.
    for (const sky of [morning, lunch, afternoon]) {
      const shadow = sky.shadow;
      expect(shadow & 0xff).toBeGreaterThan((shadow >> 16) & 0xff);
    }
  });

  it("builds snow up slowly over a spell and melts it after; rain soaks in faster", () => {
    // The first snowy spell of a winter day, at its start and an hour in.
    const day = new Date(2027, 0, 1);
    let start: Date | null = null;
    for (let h = 4; h < 24 && !start; h += 4) {
      const at = new Date(day.getTime() + h * 3_600_000);
      const before = new Date(at.getTime() - 4 * 3_600_000);
      if (weatherFor(at) === "snow" && weatherFor(before) !== "snow") start = at;
    }
    if (start) {
      const early = coverAt(new Date(start.getTime() + 30 * 60_000));
      const later = coverAt(new Date(start.getTime() + 150 * 60_000));
      expect(early?.kind).toBe("snow");
      expect(early?.level ?? 1).toBeLessThan(0.3);
      expect(later?.level ?? 0).toBeGreaterThan(early?.level ?? 1);
    }
    // Stepped, so the map is rebuilt only a dozen times as it builds.
    expect(coverStep({ kind: "rain", level: 0.51 })?.level).toBeCloseTo(6 / 12);
    expect(coverStep({ kind: "snow", level: 0.01 })).toBeNull();
  });

  it("settles snow on roofs and tops first, darkens the ground in rain, leaves water alone", () => {
    const base = new PixelBuffer(4, 1);
    base.set(0, 0, 0x8a6a3a); // a roof
    base.set(1, 0, 0xd08f35); // dirt
    base.set(2, 0, 0x8ac0ab); // water
    base.set(3, 0, 0x7a5a2a); // a wall
    const surface = Uint8Array.from([SURFACE.top, SURFACE.ground, SURFACE.water, SURFACE.side]);
    const sky = farmSkyAt(12.5);
    const plain = weatherBackground(base, surface, sky, null, 1).pixels;
    const rain = weatherBackground(base, surface, sky, { kind: "rain", level: 1 }, 1).pixels;
    const lum = (b: PixelBuffer, x: number): number => {
      const c = b.rgb(x, 0);
      return ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
    };
    expect(lum(rain, 1)).toBeLessThan(lum(plain, 1)); // wet ground is darker
    expect(rain.rgb(2, 0)).toBe(plain.rgb(2, 0)); // the pond isn't "wet"
    // Snow: across many roof pixels, some settle at full cover; never on walls or water.
    const wide = new PixelBuffer(64, 2);
    const codes = new Uint8Array(128);
    for (let x = 0; x < 64; x++) {
      wide.set(x, 0, 0x8a6a3a);
      codes[x] = SURFACE.top;
      wide.set(x, 1, 0x8ac0ab);
      codes[64 + x] = SURFACE.water;
    }
    const snowy = weatherBackground(wide, codes, sky, { kind: "snow", level: 1 }, 1).pixels;
    const before = weatherBackground(wide, codes, sky, null, 1).pixels;
    let roofSnow = 0;
    for (let x = 0; x < 64; x++) {
      if (snowy.rgb(x, 0) !== before.rgb(x, 0)) roofSnow++;
      expect(snowy.rgb(x, 1)).toBe(before.rgb(x, 1));
    }
    expect(roofSnow).toBeGreaterThan(0);
    // A light dusting, never a blanket.
    expect(roofSnow).toBeLessThan(48);
  });

  /**
   * A 2-wide post at x=14..15 standing on the foot line y=19, 12px tall
   * (all of it side, none of it facing the sky), on a 40×24 map.
   */
  const post = () => {
    const width = 40;
    const height = 24;
    const owner = new Int32Array(width * height).fill(-1);
    for (let y = 8; y <= 19; y++) {
      owner[y * width + 14] = 0;
      owner[y * width + 15] = 0;
    }
    return { width, height, relief: lightRelief(width, height, { owner, bases: [19], tops: [7] }) };
  };
  const nightAlpha = (b: PixelBuffer | null, width: number, x: number, y: number): number =>
    b?.data[(y * width + x) * 4 + 3] ?? 255;

  it("throws a shadow along the ground behind anything standing between a lamp and it", () => {
    const { width, height, relief } = post();
    const lamp = { x: 6, y: 19, z: 4, r: 30, strength: 1 };
    const ov = skyOverlay(width, height, farmSkyAt(23), weatherLook("clear"), [lamp], relief);
    const open = skyOverlay(width, height, farmSkyAt(23), weatherLook("clear"), [lamp]);
    // Just behind the post it's dark; without the post the same spot is lit.
    expect(nightAlpha(ov, width, 20, 19)).toBeGreaterThan(nightAlpha(open, width, 20, 19));
    // On the lamp's own side, nothing changes.
    expect(nightAlpha(ov, width, 3, 19)).toBe(nightAlpha(open, width, 3, 19));
  });

  it("lights the side of something facing a lamp, and not the side turned away from it", () => {
    // The same lamp in front of the post (nearer the camera), then behind it.
    // From behind, it lights the ground round the post but not the post.
    const { width, height, relief } = post();
    const sky = farmSkyAt(23);
    const dark = skyOverlay(width, height, sky, weatherLook("clear"), [], relief);
    const front = skyOverlay(
      width,
      height,
      sky,
      weatherLook("clear"),
      [{ x: 15, y: 23, z: 6, r: 16, strength: 1 }],
      relief,
    );
    const behind = skyOverlay(
      width,
      height,
      sky,
      weatherLook("clear"),
      [{ x: 15, y: 15, z: 6, r: 16, strength: 1 }],
      relief,
    );
    // The post's face, partway up.
    expect(nightAlpha(front, width, 15, 14)).toBeLessThan(nightAlpha(dark, width, 15, 14));
    expect(nightAlpha(behind, width, 15, 14)).toBe(nightAlpha(dark, width, 15, 14));
    // The ground beside the post behind it is lit all the same.
    expect(nightAlpha(behind, width, 11, 15)).toBeLessThan(nightAlpha(dark, width, 11, 15));
  });

  it("lights a critter as a figure where it stands, never through something in front of it", () => {
    // A 4×6 body standing on y=22 just in front of the post (x 12..15), a
    // lantern in front of it: it's lit. The same body behind the post (feet
    // at y=18) is hidden there by the post, so the post's own light shows.
    const { width, height, relief } = post();
    const sky = skyLight(width, height, farmSkyAt(23), weatherLook("clear"), [], relief);
    if (!sky) throw new Error("expected a night overlay");
    const rows = ["####", "####", "####", "####", "####", "####"];
    const lantern = { x: 14, y: 23, z: 3, r: 14, strength: 1 };
    const at = (feet: number): number => {
      const patch = litPatch(
        sky,
        [lantern],
        [{ x0: 12, y0: feet - 6, rows, flip: false, feet }],
        width,
        height,
        0,
        0,
        width,
        height,
        relief,
      );
      return patch[((feet - 3) * width + 15) * 4 + 3] ?? 255;
    };
    const unlit = sky.pixels.data[(19 * width + 15) * 4 + 3] ?? 0;
    expect(at(22)).toBeLessThan(unlit);
    // Behind the post, its pixel at x=15 is the post's: the post faces the lantern and is lit like it.
    const post15 = litPatch(sky, [lantern], [], width, height, 0, 0, width, height, relief);
    expect(at(18)).toBe(post15[(15 * width + 15) * 4 + 3]);
  });

  it("eases one weather into the next instead of switching", () => {
    const snow = weatherLook("snow");
    const fog = weatherLook("fog");
    const mid = blendLook(snow, fog, 0.5);
    expect(mid.fog).toBeGreaterThan(0);
    expect(mid.fog).toBeLessThan(fog.fog);
    expect(mid.density).toBeLessThan(snow.density);
    expect(blendLook(snow, fog, 1)).toBe(fog);
    expect(blendLook(snow, fog, 0).density).toBe(snow.density);
  });

  it("melts snow from the edges in: less cover never adds snow anywhere", () => {
    const w = 48;
    const base = new PixelBuffer(w, 8);
    const codes = new Uint8Array(w * 8).fill(SURFACE.top);
    for (let y = 0; y < 8; y++) for (let x = 0; x < w; x++) base.set(x, y, 0x8a6a3a);
    const sky = farmSkyAt(12.5);
    const plain = weatherBackground(base, codes, sky, null, 3).pixels;
    const changed = (level: number): Set<number> => {
      const b = weatherBackground(base, codes, sky, { kind: "snow", level }, 3).pixels;
      const out = new Set<number>();
      for (let i = 0; i < w * 8; i++)
        if (b.rgb(i % w, Math.floor(i / w)) !== plain.rgb(i % w, Math.floor(i / w))) out.add(i);
      return out;
    };
    const full = changed(1);
    const half = changed(0.5);
    for (const i of half) expect(full.has(i)).toBe(true);
  });

  it("lights a carried lantern exactly as it would a fixed lamp in the same place", () => {
    const { width, height, relief } = post();
    const lamp = { x: 10, y: 20, z: 5, r: 16, strength: 0.85 };
    const sky = farmSkyAt(23);
    const fixed = skyLight(width, height, sky, weatherLook("clear"), [lamp], relief);
    const dark = skyLight(width, height, sky, weatherLook("clear"), [], relief);
    if (!fixed || !dark) throw new Error("expected a night overlay");
    const patch = litPatch(dark, [lamp], [], width, height, 0, 0, width, height, relief);
    expect(Array.from(patch)).toEqual(Array.from(fixed.pixels.data));
  });

  it("lights up round the lamps at night, and draws nothing in fair daylight", () => {
    const lamp = { x: 40, y: 30, z: 4, r: 20, strength: 1 };
    expect(skyOverlay(80, 60, farmSkyAt(12.5), weatherLook("clear"), [lamp])).toBeNull();
    const night = skyOverlay(80, 60, farmSkyAt(23), weatherLook("clear"), [lamp]);
    const alpha = (x: number, y: number): number => night?.data[(y * 80 + x) * 4 + 3] ?? 0;
    expect(alpha(40, 30)).toBeLessThan(alpha(2, 2));
    // Rain dims daylight a little even at noon.
    expect(skyOverlay(80, 60, farmSkyAt(12.5), weatherLook("rain"), [lamp])).not.toBeNull();
  });
});

describe("goal farm play", () => {
  const world = createFarmWorld(farm, () => 0.4);

  it("lets every thing on the farm be found under the pointer, front-most first", () => {
    const targets = farmTargets(world, createPlay(), 1000, 1000);
    const kinds = new Set(targets.map((t) => t.kind));
    for (const kind of [
      "lantern",
      "house",
      "campfire",
      "well",
      "pond",
      "spout",
      "sakura",
      "bush",
      "hen",
      "cat",
      "shiba",
      "dragonfly",
      "butterflies",
    ]) {
      expect(kinds.has(kind as never), kind).toBe(true);
    }
    // Every target is found at its own anchor or somewhere on it.
    const lantern = targets.find((t) => t.kind === "lantern");
    expect(lantern && targetAt(targets, lantern.anchor.x, lantern.anchor.y)?.kind).toBe("lantern");
  });

  it("switches a light off and on, taking its lamps out of the night's light", () => {
    const play = createPlay();
    const lantern = farm.things.find((t) => t.kind === "lantern");
    if (!lantern) throw new Error("no lantern");
    const poked = { target: lantern.id, kind: lantern.kind, name: lantern.name, x: 0, y: 0 };
    expect(poke(play, poked, 0, 1)).toMatch(/goes out/);
    expect(play.lightsOff.has(lantern.id)).toBe(true);
    const lamp = farm.lamps[lantern.lamps[0] ?? -1];
    if (!lamp) throw new Error("no lamp");
    const night = (lamps: ReturnType<typeof litLamps>) =>
      skyLight(farm.width, farm.height, farmSkyAt(23), weatherLook("clear"), lamps, farm.relief);
    const lit = night(litLamps(farm, new Set()));
    const dark = night(litLamps(farm, play.lightsOff));
    const alpha = (a: typeof lit): number =>
      a?.pixels.data[(Math.round(lamp.y) * farm.width + Math.round(lamp.x)) * 4 + 3] ?? 0;
    expect(alpha(dark)).toBeGreaterThan(alpha(lit));
    expect(poke(play, poked, 100, 1)).toMatch(/lit/);
    expect(play.lightsOff.has(lantern.id)).toBe(false);
  });

  it("gives each animal its own reactions, cycling through them", () => {
    const play = createPlay();
    const said = new Set<string>();
    for (let i = 0; i < 4; i++) {
      said.add(poke(play, { target: "hen-0", kind: "hen", name: "Hen", x: 0, y: 0 }, i * 10, i));
    }
    expect(said.size).toBe(4);
    for (const kind of ["hen", "cat", "shiba"] as const) {
      expect(REACTIONS[kind].length).toBeGreaterThanOrEqual(3);
    }
    for (const kind of [...LIGHTS]) expect(REACTIONS[kind]).toEqual(["toggle"]);
  });

  it("pauses an animal while it reacts, then lets it carry on from where it stopped", () => {
    const play = createPlay();
    poke(play, { target: "cat", kind: "cat", name: "Cat", x: 0, y: 0 }, 1000, 1);
    // Frozen during the reaction: its clock doesn't move.
    expect(animalClock(play, "cat", 1200)).toBe(animalClock(play, "cat", 1800));
    // After, it runs again, behind the real time by how long it was frozen.
    const after = animalClock(play, "cat", 10_000);
    expect(after).toBeLessThan(10_000);
    expect(animalClock(play, "cat", 10_100) - after).toBe(100);
  });

  it("drops what a shake knocks loose onto the terrain in front of the tree, where it lingers", () => {
    const play = createPlay();
    const tree = farm.things.find((t) => t.kind === "sakura");
    if (!tree) throw new Error("no cherry tree");
    poke(play, { target: tree.id, kind: tree.kind, name: tree.name, x: 0, y: 0 }, 0, 5);
    const r = play.reactions[0];
    if (!r) throw new Error("no reaction");
    const pieces = spawnDebris(farm, r);
    expect(pieces.length).toBeGreaterThan(5);
    for (const d of pieces) {
      const i = Math.round(d.rest.y) * farm.width + Math.round(d.rest.x);
      // On open ground (or water), never on a wall or under something standing.
      expect(farm.surface[i]).not.toBe(SURFACE.side);
      expect(farm.solids.owner[i]).toBe(-1);
      // Near the trunk's foot, and lying there well after landing.
      expect(Math.abs(d.rest.y - tree.base)).toBeLessThan(20);
      expect(d.until - d.land).toBeGreaterThan(5000);
    }
  });

  it("puts a ripple from the pond's stones in the nearest open water", () => {
    const pond = farm.things.find((t) => t.kind === "pond");
    if (!pond) throw new Error("no pond");
    // A stone pixel of the ring.
    let stone: { x: number; y: number } | null = null;
    for (let y = pond.y; y < pond.y + pond.buf.height && !stone; y++) {
      for (let x = pond.x; x < pond.x + pond.buf.width && !stone; x++) {
        if (farm.surface[y * farm.width + x] === SURFACE.top) stone = { x, y };
      }
    }
    if (!stone) throw new Error("no stone");
    const water = nearestWater(farm, stone.x, stone.y);
    expect(water && farm.surface[water.y * farm.width + water.x]).toBe(SURFACE.water);
  });

  it("marks GG Goals with its gold crown and a KEN nameplate, and no worker", () => {
    const w = createFarmWorld(farm, () => 0.4);
    const agents = collectWorldAgents({
      running: true,
      liveTools: [{ name: "read", status: "running", args: { file_path: "a.ts" } } as never],
      waitingOnUser: false,
      workers: [worker({ status: "running" })],
    });
    for (let t = 0; t <= 30_000; t += 100) {
      syncFarm(w, agents, t);
      stepFarm(w, t);
    }
    // Colours drawn while drawing the farm once.
    const fills = new Set<string>();
    let style = "";
    const ctx = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "fillRect"
            ? () => fills.add(style)
            : key === "fillStyle"
              ? style
              : () => undefined,
        set: (_target, key, value) => {
          if (key === "fillStyle") style = String(value);
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
    drawFarm(ctx, {} as CanvasImageSource, w, 30_000, 30_000, [], null, null, null, null);
    // The crown's gold and its red jewel, and the nameplate's gold plate.
    expect(fills.has("#ffd23a")).toBe(true);
    expect(fills.has("#e8313f")).toBe(true);
    expect(fills.has("#e9af54")).toBe(true);
    // Without GG Goals on the farm, none of it.
    const alone = createFarmWorld(farm, () => 0.4);
    const workersOnly = agents.filter((a) => !a.coordinator);
    for (let t = 0; t <= 30_000; t += 100) {
      syncFarm(alone, workersOnly, t);
      stepFarm(alone, t);
    }
    fills.clear();
    drawFarm(ctx, {} as CanvasImageSource, alone, 30_000, 30_000, [], null, null, null, null);
    expect(fills.has("#e8313f")).toBe(false);
    expect(fills.has("#e9af54")).toBe(false);
  });

  it("leaves the hover glow off a thing while it reacts to a click, and back once it settles", () => {
    // Regression: the glow traces the thing at rest, so while a clicked tree
    // swayed or a well shook it hung where the thing had been.
    const w = createFarmWorld(farm, () => 0.4);
    const play = createPlay();
    const well = farmTargets(w, play, 0, 0).find((t) => t.kind === "well");
    if (!well) throw new Error("no well");
    play.hover = well.anchor;
    // Its ring is made once and cached; a marker image stands in for it here.
    const ring = { ring: true } as unknown as CanvasImageSource;
    play.rings.set(well.id, ring);
    let glows = 0;
    const ctx = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "drawImage"
            ? (img: unknown) => {
                if (img === ring) glows++;
              }
            : () => undefined,
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    const background = {} as CanvasImageSource;
    const frame = (now: number): number => {
      glows = 0;
      drawFarm(ctx, background, w, now, now, [], null, null, null, play);
      return glows;
    };
    expect(frame(0)).toBe(1);
    poke(play, { target: well.id, kind: well.kind, name: well.name, x: 0, y: 0 }, 10, 1);
    expect(play.hovered).toBe(well.id);
    expect(frame(20)).toBe(0);
    const until = Math.max(...play.reactions.map((r) => r.until));
    expect(frame(until + 1)).toBe(1);
  });

  it("sways a poked tree smoothly and keeps its trunk's foot in the ground", () => {
    // Regressions: a poke shook the whole tree side to side, trunk and all;
    // then its leaves flickered a pixel each way every few frames.
    const w = createFarmWorld(farm, () => 0.4);
    const tree = farm.things.find((t) => t.kind === "tree" && t.occluder >= 0);
    if (!tree) throw new Error("no tree");
    const o = farm.occluders[tree.occluder];
    if (!o) throw new Error("no occluder");
    const image = { tree: true } as unknown as CanvasImageSource;
    const occluders = farm.occluders.map((each, i) => ({
      image: i === tree.occluder ? image : ({} as CanvasImageSource),
      x: each.x,
      y: each.y,
      w: each.buf.width,
      h: each.buf.height,
      base: each.base,
    }));
    // Each band of rows redrawn, and how far it was moved.
    let bands: Array<{ top: number; rows: number; dx: number }> = [];
    const ctx = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "drawImage"
            ? (img: unknown, ...a: number[]) => {
                if (img !== image || a.length < 8) return;
                bands.push({ top: a[1] ?? 0, rows: a[3] ?? 0, dx: (a[4] ?? 0) - o.x });
              }
            : () => undefined,
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    const play = createPlay();
    poke(play, { target: tree.id, kind: tree.kind, name: tree.name, x: 0, y: 0 }, 0, 1);
    let leavesMoved = false;
    // The crown's offset frame by frame (60fps), to check the sway is smooth.
    const crownAt: number[] = [];
    for (let now = 16; now < 1500; now += 16) {
      bands = [];
      drawFarm(ctx, {} as CanvasImageSource, w, now, now, occluders, null, null, null, play);
      if (bands.length === 0) continue;
      // Every row is redrawn exactly once.
      expect(bands.reduce((n, b) => n + b.rows, 0)).toBe(o.buf.height);
      // The trunk's foot (its bottom rows) never moves.
      const foot = bands.find((b) => b.top + b.rows === o.buf.height);
      expect(foot?.dx).toBe(0);
      if (bands.some((b) => b.top <= o.topRow && b.dx !== 0)) leavesMoved = true;
      crownAt.push(bands.find((b) => b.top === 0)?.dx ?? 0);
    }
    expect(leavesMoved).toBe(true);
    // Smooth: at most a pixel between frames, and it changes direction only a
    // few times (a couple of swings), never flicking back and forth.
    let turns = 0;
    let last = 0;
    for (let i = 1; i < crownAt.length; i++) {
      const step = (crownAt[i] ?? 0) - (crownAt[i - 1] ?? 0);
      expect(Math.abs(step)).toBeLessThanOrEqual(1);
      if (step !== 0) {
        if (last !== 0 && Math.sign(step) !== Math.sign(last)) turns++;
        last = step;
      }
    }
    expect(turns).toBeLessThanOrEqual(5);
  });

  it("clears a swaying tree's still self from under it, and only while it sways", () => {
    // Regression: the moving tree was drawn over the map's still one, so both
    // showed (a doubled edge where it leaned).
    const w = createFarmWorld(farm, () => 0.4);
    const tree = farm.things.find((t) => t.kind === "tree" && t.occluder >= 0);
    if (!tree) throw new Error("no tree");
    const bare = { bare: true } as unknown as CanvasImageSource;
    const play = createPlay();
    play.swayBase = { farm, image: bare };
    const patches: number[][] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "drawImage"
            ? (img: unknown, ...a: number[]) => {
                if (img === bare) patches.push(a);
              }
            : () => undefined,
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    const frame = (now: number): void => {
      patches.length = 0;
      drawFarm(ctx, {} as CanvasImageSource, w, now, now, [], null, null, null, play);
    };
    frame(0);
    expect(patches).toHaveLength(0);
    poke(play, { target: tree.id, kind: tree.kind, name: tree.name, x: 0, y: 0 }, 0, 1);
    frame(300);
    // The tree's whole box (plus room to sway), repainted from the bare map.
    expect(patches).toHaveLength(1);
    // (Clipped to the map: a tree can overhang its edge.)
    const [sx, sy, sw, sh] = patches[0] ?? [];
    expect(sx).toBeLessThanOrEqual(Math.max(0, tree.x));
    expect(sy).toBe(Math.max(0, tree.y));
    expect((sx ?? 0) + (sw ?? 0)).toBeGreaterThanOrEqual(
      Math.min(farm.width, tree.x + tree.buf.width),
    );
    expect((sy ?? 0) + (sh ?? 0)).toBe(Math.min(farm.height, tree.y + tree.buf.height));
    // Settled again: the map's own tree shows.
    frame(5000);
    expect(patches).toHaveLength(0);
    // A bare map from another farm (a resize mid-paint) is never used.
    play.swayBase = { farm: {}, image: bare };
    poke(play, { target: tree.id, kind: tree.kind, name: tree.name, x: 0, y: 0 }, 6000, 2);
    frame(6300);
    expect(patches).toHaveLength(0);
  });

  it("paints the farm without its trees and bushes, keeping everything else", () => {
    const bare = paintSwayBase(farm);
    const full = composeMap(farm.scene);
    const tree = farm.things.find((t) => t.kind === "tree" && t.occluder >= 0);
    const house = farm.things.find((t) => t.kind === "house");
    if (!tree || !house) throw new Error("missing tree or house");
    const differs = (t: (typeof farm.things)[number]): boolean => {
      for (let y = t.y; y < t.y + t.buf.height; y++) {
        for (let x = t.x; x < t.x + t.buf.width; x++) {
          if (bare.rgb(x, y) !== full.rgb(x, y)) return true;
        }
      }
      return false;
    };
    expect(differs(tree)).toBe(true);
    // Only trees and bushes come out: the house's own pixels are untouched
    // wherever no tree or bush stands over them.
    const sways = new Set(["tree", "sakura", "camellia", "yuzu", "bush"]);
    const overlapsSway = farm.things.some(
      (t) =>
        sways.has(t.kind) &&
        t.x < house.x + house.buf.width &&
        t.x + t.buf.width > house.x &&
        t.y < house.y + house.buf.height &&
        t.y + t.buf.height > house.y,
    );
    if (!overlapsSway) expect(differs(house)).toBe(false);
  });

  it("grades the tree-less copy like the map, so no box shows round a swaying tree", () => {
    // Regression: the copy was ungraded, so at night (or in rain or snow) the
    // patch under a swaying tree showed as a lighter box.
    const base = composeMap(farm.scene);
    const bare = paintSwayBase(farm);
    const surface = swaySurface(farm);
    const tree = farm.things.find((t) => t.kind === "tree" && t.x > 10);
    if (!tree) throw new Error("no tree");
    for (const [hour, cover] of [
      [23, null],
      [9, { kind: "snow", level: 0.8 }],
    ] as const) {
      const sky = farmSkyAt(hour);
      const live = weatherBackground(base, farm.surface, sky, cover, 7).pixels;
      const patch = weatherBackground(bare, surface, sky, cover, 7).pixels;
      for (let y = tree.y; y < tree.y + tree.buf.height; y += 2) {
        for (let x = tree.x - 3; x < tree.x + tree.buf.width + 3; x += 2) {
          // Where the tree itself was, the copy shows what's behind it.
          if (base.rgb(x, y) !== bare.rgb(x, y)) continue;
          expect(patch.rgb(x, y)).toBe(live.rgb(x, y));
        }
      }
    }
  });

  it("hangs the campfire's pot low in the fire, inside the ring of stones", () => {
    // Regression: the kettle hung high on a tall tripod, over the back stones.
    const fire = fireTop(false).buf;
    const pot = 0x2a2420;
    let lowest = -1;
    let highest = fire.height;
    for (let y = 0; y < fire.height; y++) {
      // The pot's body is a few pixels wide; the chain above it is one.
      let run = 0;
      for (let x = 0; x < fire.width; x++) {
        if (fire.opaque(x, y) && fire.rgb(x, y) === pot) run++;
      }
      if (run < 3) continue;
      lowest = Math.max(lowest, y);
      highest = Math.min(highest, y);
    }
    // The ring's middle is row 26, its back stones about row 20: the pot's
    // belly sits below them, and nothing of it rides high above the fire.
    expect(lowest).toBeGreaterThanOrEqual(21);
    expect(highest).toBeGreaterThanOrEqual(14);
  });

  it("keeps a shaking thing behind whatever stands in front of it", () => {
    // Regression: a poked tree behind the kura was redrawn over its roof.
    const w = createFarmWorld(farm, () => 0.4);
    const boxOf = (t: (typeof farm.things)[number]) => ({
      x0: t.x,
      x1: t.x + t.buf.width,
      y0: t.y,
      y1: t.y + t.buf.height,
    });
    const shakes = new Set(["tree", "sakura", "bush", "camellia", "yuzu", "kennel"]);
    let pair: [(typeof farm.things)[number], (typeof farm.things)[number]] | null = null;
    for (const back of farm.things) {
      if (!shakes.has(back.kind) || back.occluder < 0) continue;
      const b = boxOf(back);
      const front = farm.things.find((f) => {
        if (f === back || f.occluder < 0 || f.base <= back.base) return false;
        const o = boxOf(f);
        return o.x0 < b.x1 && o.x1 > b.x0 && o.y1 > b.y0 && back.base > o.y0;
      });
      if (front) {
        pair = [back, front];
        break;
      }
    }
    if (!pair) throw new Error("no thing standing behind another");
    const [back, front] = pair;
    const images = farm.occluders.map((_, i) => ({ occluder: i }) as unknown as CanvasImageSource);
    const occluders = farm.occluders.map((o, i) => ({
      image: images[i] as CanvasImageSource,
      x: o.x,
      y: o.y,
      w: o.buf.width,
      h: o.buf.height,
      base: o.base,
    }));
    const drawn: number[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "drawImage"
            ? (img: unknown) => {
                const i = images.indexOf(img as CanvasImageSource);
                if (i >= 0) drawn.push(i);
              }
            : () => undefined,
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    const play = createPlay();
    poke(play, { target: back.id, kind: back.kind, name: back.name, x: 0, y: 0 }, 0, 1);
    drawFarm(ctx, {} as CanvasImageSource, w, 10, 10, occluders, null, null, null, play);
    const shook = drawn.lastIndexOf(back.occluder);
    expect(shook).toBeGreaterThanOrEqual(0);
    expect(drawn.lastIndexOf(front.occluder)).toBeGreaterThan(shook);
  });

  it("knows what stands in front of what, so a hover outline passes behind nearer things", () => {
    const house = farm.things.find((t) => t.kind === "house");
    const lantern = farm.things.find((t) => t.kind === "lantern");
    if (!house || !lantern) throw new Error("missing house or lantern");
    // Every lantern pixel is in front of the house: the house's outline is hidden there.
    let checked = 0;
    for (let y = lantern.y; y < lantern.y + lantern.buf.height; y++) {
      for (let x = lantern.x; x < lantern.x + lantern.buf.width; x++) {
        const sx = lantern.flip ? lantern.buf.width - 1 - (x - lantern.x) : x - lantern.x;
        if (!lantern.buf.opaque(sx, y - lantern.y)) continue;
        expect(farm.solids.front[y * farm.width + x]).toBeGreaterThan(house.base);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("never changes what the agents are doing", () => {
    const w = createFarmWorld(farm, () => 0.4);
    syncFarm(w, previewCrowd(0), 0);
    const before = [...w.actors.values()].map((a) => [a.key, a.want, a.station]);
    const play = createPlay();
    for (const t of farmTargets(w, play, 100, 100)) {
      poke(
        play,
        { target: t.id, kind: t.kind, name: t.name, x: t.anchor.x, y: t.anchor.y },
        100,
        1,
      );
    }
    expect([...w.actors.values()].map((a) => [a.key, a.want, a.station])).toEqual(before);
  });
});

describe("goal farm things in use", () => {
  const worker = (key: string, kind: WorldAgent["kind"]): WorldAgent => ({
    key,
    agentName: "worker",
    name: key,
    coordinator: false,
    status: "working",
    kind,
    detail: "Working",
  });

  it("finds the thing each station's critters use, and every use is one of its reactions", () => {
    const things = stationThings(farm);
    for (const station of STATION_KINDS) {
      const use = STATION_USES[station];
      expect(things.get(station)?.kind, station).toBe(use.kind);
      for (const action of use.actions) expect(REACTIONS[use.kind], station).toContain(action);
    }
  });

  it("brings the laptop to life while a critter is on the web, one animation at a time", () => {
    // Two critters at the laptop: it plays once, isn't restarted while it
    // plays, and plays again only after it finishes, if they're still there.
    const world = createFarmWorld(farm, draws(0.5));
    syncFarm(world, [coordinatorAgent(), worker("a", "web"), worker("b", "web")], 0);
    stepFarm(world, 0, true);
    const inUse = stationsInUse(world);
    expect(inUse.has("computer")).toBe(true);
    const things = stationThings(farm);
    const laptop = things.get("computer");
    if (!laptop) throw new Error("no laptop");

    const play = createPlay();
    const started = playUses(play, things, inUse, 1000);
    const first = reactionOn(play, laptop.id, 1000);
    expect(first?.action).toBe("wake");
    expect(first?.use).toBe(true);
    // What started is reported (for its sound).
    expect(started).toContain(first);
    // Still playing: called again (each frame), nothing restarts or stacks.
    expect(playUses(play, things, inUse, 1500)).toEqual([]);
    expect(play.reactions.filter((r) => r.target === laptop.id)).toEqual([first]);
    // Finished, still in use: the next one starts then.
    const after = (first?.until ?? 0) + 1;
    settlePlay(play, after);
    playUses(play, things, inUse, after);
    expect(reactionOn(play, laptop.id, after)?.start).toBe(after);
    // Nobody there any more: once it finishes, it stays still.
    const later = (reactionOn(play, laptop.id, after)?.until ?? 0) + 1;
    settlePlay(play, later);
    playUses(play, things, new Set(), later);
    expect(reactionOn(play, laptop.id, later)).toBeNull();
  });

  it("lets a poke play over a thing in use, and waits for it before using it again", () => {
    const things = stationThings(farm);
    const bookcase = things.get("bookcase");
    if (!bookcase) throw new Error("no bookcase");
    const play = createPlay();
    poke(play, { target: bookcase.id, kind: "bookcase", name: "Bookcase", x: 0, y: 0 }, 0, 1);
    playUses(play, things, new Set(["bookcase"]), 100);
    expect(play.reactions.filter((r) => r.target === bookcase.id)).toHaveLength(1);
    expect(reactionOn(play, bookcase.id, 100)?.use).toBeUndefined();
  });

  it("counts only critters settled at work (or lounging), and keeps an idle farm at its idle rate", () => {
    const world = createFarmWorld(farm, draws(0.5));
    syncFarm(world, [coordinatorAgent(), worker("r", "read")], 0);
    stepFarm(world, 0, true);
    expect([...stationsInUse(world)].sort()).toEqual(["bookcase", "whiteboard"]);
    // A newcomer still walking in uses nothing yet.
    syncFarm(world, [coordinatorAgent(), worker("r", "read"), worker("e", "edit")], 100);
    expect(stationsInUse(world).has("workbench")).toBe(false);

    const things = stationThings(farm);
    const play = createPlay();
    playUses(play, things, new Set(["lounge"]), 0);
    // Ken's tea steaming while he waits: not "playing", and no faster drawing.
    expect(playing(play, 10)).toBe(false);
    expect(usesNeedPace(play, 10)).toBe(false);
    playUses(play, things, new Set(["workbench"]), 0);
    expect(usesNeedPace(play, 10)).toBe(true);
  });
});

describe("goal finish", () => {
  const run = (over: Partial<GoalRun> = {}): GoalRun => ({
    goalId: "g",
    startedAt: 1000,
    endedAt: 2000,
    fromItemId: 10,
    turns: 3,
    outputTokens: 400,
    outcome: "done",
    ...over,
  });

  it("scores the stretch since the last finish or cancel", () => {
    const runs = [
      run({ startedAt: 0, endedAt: 500, outcome: "cancelled" }),
      run({ startedAt: 1000, endedAt: 2000, fromItemId: 10 }),
      run({ startedAt: 5000, endedAt: 8000, fromItemId: 20, turns: 2, outputTokens: 100 }),
      run({ goalId: "other", endedAt: 9000 }),
    ];
    const stretch = openStretch(runs, "g", 0);
    expect(stretch.map((r) => r.endedAt)).toEqual([2000, 8000]);
    expect(openStretch(runs, "g", 2000).map((r) => r.endedAt)).toEqual([8000]);
    const groups = [
      { id: 5, agents: [{ toolCallId: "old", status: "done", activities: [], toolUseCount: 1 }] },
      {
        id: 12,
        agents: [
          {
            toolCallId: "a",
            status: "done",
            activities: [],
            toolUseCount: 4,
            tokenUsage: { input: 9, output: 1000 },
          },
          { toolCallId: "b", status: "error", activities: [], toolUseCount: 1 },
        ],
      },
    ] satisfies CritterGroup[];
    const finish = goalFinishOf(stretch, groups, {
      messageId: 30,
      face: "proud",
      text: "Mobile load is down to 1.4 seconds.",
    });
    expect(finish).toMatchObject({
      id: 8000,
      outcome: "done",
      elapsedMs: 7000,
      turns: 5,
      workers: 2,
      failedWorkers: 1,
      outputTokens: 1500,
      face: "proud",
      line: "Mobile load is down to 1.4 seconds.",
    });
  });

  it("falls back to a plain line when Ken said nothing during the stretch", () => {
    const finish = goalFinishOf([run({ outcome: "failed" })], [], {
      messageId: 3,
      face: "happy",
      text: "An older line",
    });
    expect(finish).toMatchObject({ outcome: "failed", face: "sad" });
    expect(finish?.line).toContain("couldn't finish");
    expect(goalFinishOf([], [], null)).toBeNull();
  });

  it("only counts as quiet with nothing running, asked, paused or at work", () => {
    const quiet = { paused: false, running: false, waitingOnUser: false, workers: [] };
    expect(goalIsQuiet(quiet)).toBe(true);
    expect(goalIsQuiet({ ...quiet, running: true })).toBe(false);
    expect(goalIsQuiet({ ...quiet, paused: true })).toBe(false);
    expect(goalIsQuiet({ ...quiet, waitingOnUser: true })).toBe(false);
    expect(goalIsQuiet({ ...quiet, workers: [worker()] })).toBe(false);
    expect(goalIsQuiet({ ...quiet, workers: [worker({ status: "idle" })] })).toBe(true);
  });
});
