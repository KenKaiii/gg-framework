import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { findMotionBundle } from "../core/skills.js";

type Pose = { x: number; y: number; zoom: number; rotate: number };
type CameraState = Pose & { offsetX: number; offsetY: number };
type Plan = { first: Pose; moves: unknown[] };
type CursorPlan = { duration: number; presses: number[] };
type Stop = { x: number; y: number; click?: boolean; hold?: number };
type Rest = [number, number];
type CameraOpts = {
  handheld?: { amp?: number; seed?: number };
  rests?: Rest[];
  shakes?: Array<{ at: number; amount?: number }>;
  duration?: number;
  lead?: number;
};
type CameraKey = Partial<Pose> & { at?: number; move?: string; duration?: number };
/** The slice of a GSAP timeline the cue clock reads. */
type NestedTimeline = {
  parent: NestedTimeline | null;
  startTime: () => number;
  timeScale: () => number;
};
type Cue = { t: number; sfx: string; gain: number; pan: number; send?: number; name?: string };
type Air = { rate: number; start: number; values: number[] };

/** The kit's public surface used by these tests. */
type Kit = {
  springs: Record<string, unknown>;
  spring: (t: number, spec?: string) => number;
  settleTime: (spec?: string, tolerance?: number) => number;
  ease: Record<string, (p: number) => number>;
  rng: (seed?: number) => () => number;
  noise: (seed: number, t: number) => number;
  typePlan: (text: string, opts?: { seed?: number }) => { times: number[]; duration: number };
  hopAt: (t: number) => { lift: number; sx: number; sy: number };
  cameraPlan: (keys: CameraKey[], opts?: CameraOpts) => Plan;
  cameraAt: (plan: Plan, t: number, opts?: CameraOpts) => CameraState;
  handheld: (t: number, opts?: { rests?: Rest[] }) => { x: number; y: number; rotate: number };
  toScreen: (cam: CameraState, x: number, y: number) => { x: number; y: number };
  atDepth: (cam: CameraState, depth: number) => CameraState;
  camera: (
    tl: FakeTimeline,
    world: FakeElement,
    keys: CameraKey[],
    opts?: CameraOpts & { layers?: Array<{ el: FakeElement; depth: number }> },
  ) => unknown;
  cursorPlan: (stops: Stop[]) => CursorPlan;
  cursorAt: (plan: CursorPlan, t: number) => { x: number; y: number; scale: number };
  cursorPath: (
    tl: FakeTimeline,
    cursor: FakeElement,
    at: number,
    stops: Stop[],
  ) => { end: number; presses: number[] };
  converge: (
    tl: FakeTimeline,
    els: FakeElement[],
    at: number,
    target: { x: number; y: number },
  ) => number;
  hop: (tl: FakeTimeline, el: FakeElement, at: number) => number;
  typewrite: (tl: FakeTimeline, el: FakeElement, at: number) => number;
  cue: (
    tl: NestedTimeline,
    at: number,
    sfx: string,
    opts?: { gain?: number; pan?: number; x?: number; send?: number; name?: string },
  ) => number;
  cues: () => Cue[];
  air: () => Air | null;
  cameraSpeed: (plan: Plan, t: number) => number;
  deepZoomAt: (t: number, opts?: DeepZoomOpts) => CameraState;
  deepZoom: (tl: FakeTimeline, world: FakeElement, at: number, opts?: DeepZoomOpts) => number;
  lightLevel: (t: number, opts?: Record<string, unknown>) => number;
  lightGround: (
    tl: FakeTimeline,
    el: FakeElement | FakeCanvas,
    at: number,
    opts?: Record<string, unknown>,
  ) => number;
  ringsAt: (t: number, opts?: Record<string, unknown>) => Array<{ r: number; inner: number }>;
  rings: (tl: FakeTimeline, el: FakeElement, at: number, opts?: Record<string, unknown>) => number;
  silkField: (t: number, opts?: Record<string, unknown>) => Uint8ClampedArray;
  silk: (
    tl: FakeTimeline,
    canvas: FakeCanvas,
    at: number,
    duration: number,
    opts?: Record<string, unknown>,
  ) => number;
  grainTile: (opts?: { size?: number; amount?: number; seed?: number }) => Uint8ClampedArray;
  grain: (el: FakeElement, opts?: Record<string, unknown>) => string;
  beltAt: (
    t: number,
    opts?: Record<string, unknown>,
  ) => { offset: number; speed: number; clock: number };
  belt: (
    tl: FakeTimeline,
    items: FakeElement[],
    at: number,
    opts?: Record<string, unknown>,
  ) => { stop: number; at: (t: number) => { offset: number }; clock: (t: number) => number };
  pathPoints: (d: string, step?: number) => Array<{ x: number; y: number }>;
  brushStroke: (
    tl: FakeTimeline,
    canvas: FakeCanvas,
    at: number,
    opts?: Record<string, unknown>,
  ) => number;
  halftoneTile: (opts?: Record<string, unknown>) => { size: number; data: Uint8ClampedArray };
  printInk: (el: FakeElement, opts?: Record<string, unknown>) => string;
  misregisterAt: (
    t: number,
    count: number,
    opts?: Record<string, unknown>,
  ) => Array<{ x: number; y: number }>;
  misregister: (
    tl: FakeTimeline,
    layers: FakeElement[],
    at: number,
    opts?: Record<string, unknown>,
  ) => number;
  paperTile: (opts?: Record<string, unknown>) => Uint8ClampedArray;
  paperTexture: (el: FakeElement, opts?: Record<string, unknown>) => string;
};

type DeepZoomOpts = {
  anchor?: { x: number; y: number };
  from?: number;
  to?: number;
  screenFrom?: { x: number; y: number };
  screenTo?: { x: number; y: number };
  duration?: number;
  ease?: string;
};

/** A canvas whose 2D context records every call and keeps put pixels. */
type FakeCanvas = {
  width: number;
  height: number;
  style: Record<string, string>;
  calls: string[];
  pixels: Uint8ClampedArray | null;
  getContext: () => Record<string, unknown>;
  toDataURL: () => string;
};

function fakeCanvas(width = 1920, height = 1080): FakeCanvas {
  const canvas: FakeCanvas = {
    width,
    height,
    style: {},
    calls: [],
    pixels: null,
    getContext: () => ctx,
    toDataURL: () => `data:fake,${Buffer.from(canvas.pixels ?? []).toString("base64")}`,
  };
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      canvas.calls.push(
        `${name}(${args.map((a) => (typeof a === "number" ? a.toFixed(3) : String(a))).join(",")})`,
      );
    };
  const ctx: Record<string, unknown> = {
    clearRect: record("clearRect"),
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    stroke: record("stroke"),
    fillRect: record("fillRect"),
    createRadialGradient: () => ({ addColorStop: record("stop") }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image: { data: Uint8ClampedArray }) => {
      canvas.pixels = new Uint8ClampedArray(image.data);
      canvas.calls.push("putImageData");
    },
  };
  return canvas;
}

type FakeElement = {
  style: Record<string, string>;
  textContent: string;
  offsetLeft: number;
  offsetTop: number;
  offsetWidth: number;
  offsetHeight: number;
  offsetParent: FakeElement | null;
};

type Driven = { at: number; duration: number; state: { t: number }; onUpdate: () => void };

/**
 * Records the kit's `drive` tweens (the ones that draw from onUpdate) and
 * seeks them the way a paused GSAP timeline does: each tween's local time is
 * the clamped offset from its start. Other tweens are recorded and ignored.
 */
class FakeTimeline {
  driven: Driven[] = [];
  fromTo(
    _target: unknown,
    _from: unknown,
    vars: { t?: number; duration: number; onUpdate?: () => void },
    at: number,
  ): this {
    if (vars.onUpdate && typeof vars.t === "number") {
      const state = _target as { t: number };
      this.driven.push({ at, duration: vars.duration, state, onUpdate: vars.onUpdate });
    }
    return this;
  }
  to(): this {
    return this;
  }
  set(): this {
    return this;
  }
  seek(time: number): void {
    for (const d of this.driven) {
      d.state.t = Math.min(d.duration, Math.max(0, time - d.at));
      d.onUpdate();
    }
  }
}

function element(x = 0, y = 0, w = 100, h = 60, parent: FakeElement | null = null): FakeElement {
  return {
    style: {},
    textContent: "",
    offsetLeft: x,
    offsetTop: y,
    offsetWidth: w,
    offsetHeight: h,
    offsetParent: parent,
  };
}

async function motionRoot(): Promise<string> {
  const bundle = await findMotionBundle();
  if (!bundle) throw new Error("motion bundle missing");
  return bundle.root;
}

async function loadKit(page: Record<string, unknown> = {}): Promise<Kit> {
  const root = await motionRoot();
  const source = await fs.readFile(path.join(root, "library", "kit", "moves.js"), "utf8");
  const context: { GGMotionKit?: Kit } = { ...page };
  vm.runInNewContext(source, context);
  if (!context.GGMotionKit) throw new Error("moves.js did not define GGMotionKit");
  return context.GGMotionKit;
}

const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let t = from; t <= to + 1e-9; t += step) out.push(Number(t.toFixed(6)));
  return out;
};

describe("Motion move kit", () => {
  it("follows the library's determinism rules", async () => {
    const root = await motionRoot();
    const audit = (await import(
      pathToFileURL(path.join(root, "..", "..", "scripts", "motion-library-audit.mjs")).href
    )) as { auditSource: (source: string) => string[] };
    const source = await fs.readFile(path.join(root, "library", "kit", "moves.js"), "utf8");

    expect(audit.auditSource(source)).toEqual([]);
  });

  it("settles every spring at its target and stays there", async () => {
    const kit = await loadKit();

    for (const name of Object.keys(kit.springs)) {
      const settle = kit.settleTime(name);
      expect(settle, name).toBeGreaterThan(0.05);
      expect(settle, name).toBeLessThan(3);
      for (const t of range(settle, settle + 2, 0.01)) {
        expect(Math.abs(1 - kit.spring(t, name)), `${name} at ${t}`).toBeLessThan(0.0025);
      }
      expect(kit.spring(0, name)).toBe(0);
    }
    // A bouncy spring overshoots; a soft one barely does.
    const peak = (name: string): number =>
      Math.max(...range(0, kit.settleTime(name), 0.002).map((t) => kit.spring(t, name)));
    expect(peak("bouncy")).toBeGreaterThan(1.1);
    expect(peak("soft")).toBeLessThan(1.01);
  });

  it("maps every curve from 0 to 1 and repeats seeded noise exactly", async () => {
    const kit = await loadKit();

    for (const [name, fn] of Object.entries(kit.ease)) {
      expect(fn(0), name).toBeCloseTo(0, 6);
      expect(fn(1), name).toBeCloseTo(1, 6);
    }
    const a = kit.rng(42);
    const b = kit.rng(42);
    const first = Array.from({ length: 20 }, () => a());
    expect(Array.from({ length: 20 }, () => b())).toEqual(first);
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
    expect(kit.noise(3, 1.37)).toBe(kit.noise(3, 1.37));
    expect(kit.typePlan("npm run ship", { seed: 9 })).toEqual(
      kit.typePlan("npm run ship", { seed: 9 }),
    );
  });

  it("draws the same frame when a time is seeked twice, in any order", async () => {
    const kit = await loadKit();
    const tl = new FakeTimeline();
    const stage = element(0, 0, 1920, 1080);
    const world = element(0, 0, 1920, 1080, stage);
    const cursor = element(0, 0, 56, 56, stage);
    const chips = [element(100, 100, 200, 80, stage), element(1500, 900, 200, 80, stage)];
    const ball = element(300, 700, 80, 80, stage);
    const line = element(600, 500, 600, 80, stage);
    line.textContent = "npm run ship";

    kit.camera(
      tl,
      world,
      [
        { x: 960, y: 540 },
        { at: 1, x: 400, y: 300, zoom: 2 },
      ],
      {
        duration: 6,
        handheld: {},
        rests: [[3, 4]],
        shakes: [{ at: 2.2 }],
      },
    );
    kit.cursorPath(tl, cursor, 0.5, [
      { x: 100, y: 900 },
      { x: 960, y: 540, click: true },
    ]);
    kit.converge(tl, chips, 2, { x: 960, y: 540 });
    kit.hop(tl, ball, 1.5);
    kit.typewrite(tl, line, 0.2);
    const snapshot = (): string =>
      JSON.stringify([world.style, cursor.style, chips.map((c) => c.style), ball.style, line]);

    tl.seek(2.37);
    const first = snapshot();
    tl.seek(5.9);
    tl.seek(0);
    tl.seek(2.37);

    expect(snapshot()).toBe(first);
    expect(world.style.transform).toMatch(/^translate\(/);
    expect(line.textContent.length).toBeGreaterThan(0);
  });

  it("keeps the camera's subject in frame and holds dead still in rests", async () => {
    const kit = await loadKit();
    const subjects = [
      { x: 960, y: 540 },
      { x: 300, y: 260 },
      { x: 1600, y: 820 },
    ];
    const opts: CameraOpts = {
      handheld: { amp: 6 },
      rests: [[3.2, 4.4]],
      shakes: [{ at: 5.5, amount: 14 }],
    };
    const plan = kit.cameraPlan(
      [
        { x: 960, y: 540, zoom: 1 },
        { at: 1, x: 300, y: 260, zoom: 2.2, move: "whip", duration: 0.8 },
        { at: 4.6, x: 1600, y: 820, zoom: 1.8, move: "whip", duration: 0.8 },
      ],
      opts,
    );
    // The subject the camera holds between whips (a whip itself may leave everything).
    const held: Array<[number, number, { x: number; y: number }]> = [
      [0, 1, subjects[0]!],
      [1.8, 4.6, subjects[1]!],
      [5.4, 7, subjects[2]!],
    ];

    for (const [from, to, target] of held) {
      for (const t of range(from, to, 0.02)) {
        const cam = kit.cameraAt(plan, t, opts);
        const onScreen = kit.toScreen(cam, target.x, target.y);
        expect(onScreen.x, `x at ${t}`).toBeGreaterThan(0);
        expect(onScreen.x, `x at ${t}`).toBeLessThan(1920);
        expect(onScreen.y, `y at ${t}`).toBeGreaterThan(0);
        expect(onScreen.y, `y at ${t}`).toBeLessThan(1080);
      }
    }
    // Settled on a key: the subject sits at frame centre (within the float).
    const settled = kit.toScreen(kit.cameraAt(plan, 3, opts), 300, 260);
    expect(Math.abs(settled.x - 960)).toBeLessThan(12);
    expect(Math.abs(settled.y - 540)).toBeLessThan(12);
    // In the rest nothing moves at all.
    const still = kit.cameraAt(plan, 3.4, opts);
    for (const t of range(3.2, 4.4, 0.05)) expect(kit.cameraAt(plan, t, opts)).toEqual(still);
    expect(kit.handheld(3.5, { rests: [[3.2, 4.4]] })).toEqual({ x: 0, y: 0, rotate: 0 });
    // Outside it the hand floats a little.
    expect(Math.abs(kit.handheld(1.7, { rests: [[3.2, 4.4]] }).x)).toBeGreaterThan(0);
  });

  it("moves parallax layers by their depth: far layers less, near layers more", async () => {
    const kit = await loadKit();
    const tl = new FakeTimeline();
    const world = element(0, 0, 1920, 1080);
    const sky = element(0, 0, 1920, 1080);
    const hills = element(0, 0, 1920, 1080);
    const keys: CameraKey[] = [
      { x: 960, y: 540 },
      { at: 0.5, x: 1360, y: 740, zoom: 2, move: "glide", duration: 1 },
    ];
    const opts: CameraOpts = { duration: 3, handheld: {}, shakes: [{ at: 2 }] };
    kit.camera(tl, world, keys, {
      ...opts,
      layers: [
        { el: sky, depth: 0 },
        { el: hills, depth: 0.5 },
      ],
    });

    tl.seek(2.1);

    // Depth 0 never moves, whatever the camera does.
    expect(sky.style.transform).toBe(
      "translate(960px, 540px) rotate(0deg) scale(1) translate(-960px, -540px)",
    );
    // Depth 1 is the world itself.
    const cam = kit.cameraAt(kit.cameraPlan(keys, opts), 2.1, opts);
    expect(kit.atDepth(cam, 1)).toEqual(cam);
    // Halfway back: half the pan, the square root of the zoom.
    const half = kit.atDepth(cam, 0.5);
    expect(half.x - 960).toBeCloseTo((cam.x - 960) / 2, 6);
    expect(half.zoom).toBeCloseTo(Math.sqrt(cam.zoom), 6);
    expect(hills.style.transform).not.toBe(world.style.transform);
    expect(hills.style.transform).toContain(`scale(${half.zoom})`);
    expect(() => kit.camera(tl, world, keys, { layers: [{ el: sky, depth: -1 }] })).toThrow(
      /depth >= 0/,
    );
  });

  it("presses the cursor on its stops and lands hops back on the ground", async () => {
    const kit = await loadKit();
    const plan = kit.cursorPlan([
      { x: 100, y: 900 },
      { x: 960, y: 540, click: true },
      { x: 1400, y: 300, click: true },
    ]);

    expect(plan.presses).toHaveLength(2);
    for (const [i, press] of plan.presses.entries()) {
      const at = kit.cursorAt(plan, press + 0.05);
      const stop = i === 0 ? { x: 960, y: 540 } : { x: 1400, y: 300 };
      expect(at.x).toBeCloseTo(stop.x, 5);
      expect(at.y).toBeCloseTo(stop.y, 5);
      expect(at.scale).toBeLessThan(1);
    }
    expect(kit.cursorAt(plan, plan.duration).scale).toBe(1);
    expect(kit.hopAt(0.3).lift).toBeGreaterThan(100);
    expect(kit.hopAt(5)).toEqual({ lift: 0, sx: expect.closeTo(1, 2), sy: expect.closeTo(1, 2) });
  });

  it("marks sound cues in root-timeline time for the cue export, without tweens", async () => {
    const attributes = new Map<string, string>();
    const queued: Array<() => void> = [];
    const kit = await loadKit({
      document: {
        documentElement: {
          setAttribute: (name: string, value: string) => attributes.set(name, value),
        },
      },
      queueMicrotask: (task: () => void) => queued.push(task),
    });
    const globalTimeline: NestedTimeline = { parent: null, startTime: () => 0, timeScale: () => 1 };
    const main: NestedTimeline = { parent: globalTimeline, startTime: () => 0, timeScale: () => 1 };
    // A scene placed at 1.5 s that plays at double speed.
    const scene: NestedTimeline = { parent: main, startTime: () => 1.5, timeScale: () => 2 };

    expect(kit.cue(scene, 0.8, "impact", { name: "landing" })).toBe(0.8);
    kit.cue(main, 0.4, "click", { gain: 0.6, pan: -0.2 });

    // Written once, after the script finished nesting its timelines.
    expect(queued).toHaveLength(1);
    expect(attributes.size).toBe(0);
    queued[0]?.();
    const expected = [
      { t: 0.4, sfx: "click", gain: 0.6, pan: -0.2 },
      { t: 1.9, sfx: "impact", gain: 1, pan: 0, name: "landing" },
    ];
    expect(JSON.parse(attributes.get("data-gg-cues") ?? "null")).toEqual(expected);
    expect(kit.cues()).toEqual(expected);
    for (const bad of [
      () => kit.cue(main, -1, "click"),
      () => kit.cue(main, Number.NaN, "click"),
      () => kit.cue(main, 1, "Big Boom"),
      () => kit.cue(main, 1, "click", { gain: 3 }),
      () => kit.cue(main, 1, "click", { pan: 2 }),
      () => kit.cue(main, 1, "click", { send: 1.5 }),
      () => kit.cue(main, 1, "click", { x: Number.NaN }),
    ]) {
      expect(bad).toThrow();
    }
  });

  it("pans a cue with its place on screen and carries its distance", async () => {
    const kit = await loadKit();
    const main: NestedTimeline = {
      parent: { parent: null, startTime: () => 0, timeScale: () => 1 },
      startTime: () => 0,
      timeScale: () => 1,
    };

    kit.cue(main, 1, "tap", { x: 0 });
    kit.cue(main, 2, "tap", { x: 960 });
    kit.cue(main, 3, "tap", { x: 1920, send: 0.6 });
    kit.cue(main, 4, "tap", { x: 1920, pan: -0.5 });

    expect(kit.cues().map(({ pan, send }) => ({ pan, send }))).toEqual([
      { pan: -0.7, send: undefined },
      { pan: 0, send: undefined },
      { pan: 0.7, send: 0.6 },
      { pan: -0.5, send: undefined },
    ]);
    expect(Object.hasOwn(kit.cues()[0] ?? {}, "send")).toBe(false);
  });

  it("records the camera's speed for the score: zero at rest, fast through a whip", async () => {
    const attributes = new Map<string, string>();
    const queued: Array<() => void> = [];
    const kit = await loadKit({
      document: {
        documentElement: {
          setAttribute: (name: string, value: string) => attributes.set(name, value),
        },
      },
      queueMicrotask: (task: () => void) => queued.push(task),
    });
    expect(kit.air()).toBeNull();
    const tl = Object.assign(new FakeTimeline(), {
      parent: { parent: null, startTime: () => 0, timeScale: () => 1 },
      startTime: () => 0,
      timeScale: () => 1,
    });
    const keys: CameraKey[] = [
      { x: 960, y: 540 },
      { at: 1, x: 1760, y: 540, move: "whip", duration: 0.5 },
      { at: 2.5, x: 1760, y: 540, zoom: 2, move: "glide", duration: 1 },
    ];

    kit.camera(tl, element(0, 0, 1920, 1080), keys, { duration: 4.5 });
    queued.forEach((task) => task());

    const air = JSON.parse(attributes.get("data-gg-air") ?? "null") as Air;
    expect(air).toEqual(kit.air());
    expect(air.rate).toBe(50);
    expect(air.start).toBe(0);
    expect(air.values).toHaveLength(4.5 * 50 + 1);
    const at = (t: number): number => air.values[Math.round(t * 50)] ?? -1;
    expect(at(0.5)).toBe(0);
    expect(at(4.2)).toBe(0);
    // The whip is fast, the push-in is felt, and both are measured in screen px/s.
    expect(Math.max(...air.values.slice(50, 80))).toBeGreaterThan(1500);
    expect(Math.max(...air.values.slice(125, 180))).toBeGreaterThan(200);
    expect(Math.max(...air.values.slice(125, 180))).toBeLessThan(
      Math.max(...air.values.slice(50, 80)),
    );
    expect(attributes.has("data-gg-cues")).toBe(false);
  });
  it("deep-zooms 1000x with the anchor pinned to its keyed screen point", async () => {
    const kit = await loadKit();
    const anchor = { x: 1312.4, y: 377.9 };
    const opts: DeepZoomOpts = {
      anchor,
      from: 1,
      to: 1000,
      screenFrom: { x: 1312.4, y: 377.9 },
      screenTo: { x: 960, y: 540 },
      duration: 4,
    };
    for (const t of range(0, 4, 0.05)) {
      const cam = kit.deepZoomAt(t, opts);
      const p = 0.5 - 0.5 * Math.cos((Math.PI * t) / 4);
      const on = kit.toScreen(cam, anchor.x, anchor.y);
      expect(Math.abs(on.x - (1312.4 + (960 - 1312.4) * p)), `x at ${t}`).toBeLessThan(1);
      expect(Math.abs(on.y - (377.9 + (540 - 377.9) * p)), `y at ${t}`).toBeLessThan(1);
    }
    // At 1x, 100x and 1000x the anchor is exactly where it is keyed.
    for (const zoom of [1, 100, 1000]) {
      const cam = kit.deepZoomAt(0, { ...opts, from: zoom, screenFrom: { x: 200, y: 900 } });
      expect(cam.zoom).toBeCloseTo(zoom, 6);
      const on = kit.toScreen(cam, anchor.x, anchor.y);
      expect(Math.abs(on.x - 200)).toBeLessThan(1);
      expect(Math.abs(on.y - 900)).toBeLessThan(1);
    }
    expect(kit.deepZoomAt(4, opts).zoom).toBeCloseTo(1000, 6);
    // Log space: a linear ease is at the geometric mean halfway, in or out.
    expect(kit.deepZoomAt(2, { ...opts, ease: "linear" }).zoom).toBeCloseTo(Math.sqrt(1000), 6);
    expect(kit.deepZoomAt(1, { from: 1000, to: 1, duration: 2, ease: "linear" }).zoom).toBeCloseTo(
      Math.sqrt(1000),
      6,
    );

    const tl = new FakeTimeline();
    const world = element(0, 0, 1920, 1080);
    expect(kit.deepZoom(tl, world, 1, opts)).toBe(5);
    expect(world.style.transformOrigin).toBe("0 0");
    tl.seek(2.7);
    const first = world.style.transform;
    tl.seek(4.9);
    tl.seek(0);
    tl.seek(2.7);
    expect(world.style.transform).toBe(first);
    for (const bad of [
      { to: 0 },
      { from: -2 },
      { duration: 0 },
      { anchor: { x: Number.NaN, y: 0 } },
    ])
      expect(() => kit.deepZoomAt(0, bad as DeepZoomOpts)).toThrow(/deepZoom/);
  });

  it("floods light up from below and reveals the next scene through staggered rings", async () => {
    const kit = await loadKit();
    const opts = { rise: 1, hold: 0.5, drain: 1 };
    expect(kit.lightLevel(0, opts)).toBe(0);
    expect(kit.lightLevel(1.2, opts)).toBe(1);
    expect(kit.lightLevel(3, opts)).toBe(0);
    for (const t of range(0, 0.98, 0.02))
      expect(kit.lightLevel(t + 0.02, opts)).toBeGreaterThanOrEqual(kit.lightLevel(t, opts));
    expect(() => kit.lightLevel(0, { rise: -1 })).toThrow(/rise/);

    const tl = new FakeTimeline();
    const props: Record<string, string> = {};
    const field = {
      ...element(0, 0, 1920, 1080),
      style: { setProperty: (k: string, v: string) => (props[k] = v) } as unknown as Record<
        string,
        string
      >,
    };
    expect(kit.lightGround(tl, field, 2, opts)).toBe(3);
    const canvas = fakeCanvas(480, 270);
    kit.lightGround(tl, canvas, 2, opts);
    const veil = element(0, 0, 1920, 1080);
    expect(kit.rings(tl, veil, 3, { count: 4, stagger: 0.1, duration: 1 })).toBe(4);
    const shot = (): string => JSON.stringify([props, canvas.calls.slice(-6), veil.style]);
    tl.seek(2.6);
    const first = shot();
    tl.seek(4.5);
    tl.seek(0);
    tl.seek(2.6);
    expect(shot()).toBe(first);
    expect(Number(props["--light"])).toBeGreaterThan(0);
    tl.seek(3.4);
    expect(veil.style.maskImage).toMatch(/^radial-gradient\(circle at 960px 540px/);

    const ringOpts = { count: 4, stagger: 0.1, duration: 1 };
    let prev = kit.ringsAt(0, ringOpts);
    for (const t of range(0.02, 1.4, 0.02)) {
      const now = kit.ringsAt(t, ringOpts);
      now.forEach((ring, i) =>
        expect(ring.r, `ring ${i} at ${t}`).toBeGreaterThanOrEqual(prev[i]!.r),
      );
      prev = now;
    }
    const mid = kit.ringsAt(0.25, ringOpts);
    for (let i = 1; i < mid.length; i++) expect(mid[i]!.r).toBeLessThan(mid[i - 1]!.r);
    expect(kit.ringsAt(0.05, ringOpts)[1]!.r).toBe(0);
    const done = kit.ringsAt(1.3, ringOpts)[0]!;
    expect(done.inner).toBe(0);
    expect(done.r).toBeGreaterThan(Math.hypot(960, 540));
    expect(() => kit.ringsAt(0, { count: 0 })).toThrow(/count/);
  });

  it("flows silk deterministically and lays a fixed seeded grain", async () => {
    const kit = await loadKit();
    const opts = { colors: ["#0b1020", "#3a2a6a", "#e08a5c"], seed: 4, cols: 32 };
    const a = kit.silkField(1.3, opts);
    expect(a).toHaveLength(32 * 18 * 4);
    expect(kit.silkField(1.3, opts)).toEqual(a);
    expect(kit.silkField(1.3, { ...opts, seed: 5 })).not.toEqual(a);
    expect(kit.silkField(3.3, opts)).not.toEqual(a);
    expect(new Set(Array.from(a.filter((_, i) => i % 4 === 0))).size).toBeGreaterThan(20);
    expect(() => kit.silkField(0, { colors: ["#fff"] })).toThrow(/two/);
    expect(() => kit.silkField(0, { colors: ["#fff", "blue"] })).toThrow(/hex/);

    const tl = new FakeTimeline();
    const canvas = fakeCanvas();
    expect(kit.silk(tl, canvas, 1, 4, opts)).toBe(5);
    expect([canvas.width, canvas.height]).toEqual([32, 18]);
    tl.seek(2.3);
    const first = canvas.pixels;
    tl.seek(4);
    tl.seek(0);
    tl.seek(2.3);
    expect(canvas.pixels).toEqual(first);
    expect(Array.from(canvas.pixels ?? [])).toEqual(Array.from(kit.silkField(2.3, opts)));
    expect(() => kit.silk(tl, canvas, 0, 0, opts)).toThrow(/duration/);

    const tile = kit.grainTile({ seed: 3, size: 64 });
    expect(tile).toHaveLength(64 * 64 * 4);
    expect(kit.grainTile({ seed: 3, size: 64 })).toEqual(tile);
    expect(kit.grainTile({ seed: 4, size: 64 })).not.toEqual(tile);
    expect(Math.max(...Array.from(tile.filter((_, i) => i % 4 === 3)))).toBeLessThanOrEqual(13);
    const doc = { createElement: () => fakeCanvas(1, 1) };
    const one = element();
    const two = element();
    const url = kit.grain(one, { seed: 3, document: doc });
    expect(kit.grain(two, { seed: 3, document: doc })).toBe(url);
    expect(one.style.backgroundImage).toBe(`url(${url})`);
    expect(one.style.backgroundRepeat).toBe("repeat");
    expect(() => kit.grainTile({ amount: 2 })).toThrow(/amount/);
    expect(() => kit.grain(element(), {})).toThrow(/document/);
  });

  it("runs a belt at constant speed and stops it exactly at the stop time", async () => {
    const kit = await loadKit();
    const opts = { speed: 300, stop: 5, rampIn: 0.6, rampOut: 1 };
    // Numerically integrate the speed: the closed form must match it at any time.
    let dist = 0;
    const dt = 0.0005;
    for (let t = 0; t < 5 - 1e-9; t += dt) {
      dist += kit.beltAt(t + dt / 2, opts).speed * dt;
      const at = Math.round((t + dt) / dt) * dt;
      if (Math.abs(at * 4 - Math.round(at * 4)) < 1e-6)
        expect(kit.beltAt(at, opts).offset, `offset at ${at}`).toBeCloseTo(dist, 1);
    }
    expect(kit.beltAt(2, opts).speed).toBe(300);
    expect(kit.beltAt(0, opts).speed).toBe(0);
    const end = kit.beltAt(5, opts).offset;
    expect(kit.beltAt(4.999, opts).speed).toBeLessThan(0.1);
    expect(kit.beltAt(9, opts).offset).toBe(end);
    expect(kit.beltAt(5, opts).clock).toBeCloseTo(end / 300, 9);
    expect(end).toBeCloseTo(300 * (5 - 0.3 - 0.5), 6);

    const tl = new FakeTimeline();
    const items = [element(), element(), element()];
    const run = kit.belt(tl, items, 1, { speed: 300, stop: 6, spacing: 400 });
    expect(run.stop).toBe(6);
    tl.seek(3.21);
    const first = JSON.stringify(items.map((i) => i.style));
    tl.seek(7);
    const stopped = JSON.stringify(items.map((i) => i.style));
    tl.seek(6);
    expect(JSON.stringify(items.map((i) => i.style))).toBe(stopped);
    tl.seek(0);
    tl.seek(3.21);
    expect(JSON.stringify(items.map((i) => i.style))).toBe(first);
    expect(run.clock(6)).toBe(run.clock(8));
    expect(() => kit.belt(tl, items, 2, { stop: 1 })).toThrow(/stop/);
    expect(() => kit.beltAt(1, { speed: 0 })).toThrow(/speed/);
    expect(() => kit.belt(tl, [], 0)).toThrow(/item/);
  });

  it("paints a seeded brush stroke progressively, from nothing to full ink", async () => {
    const kit = await loadKit();
    const pts = kit.pathPoints("M100 500 C 400 200, 900 800, 1400 420 l 200 -40");
    expect(pts[0]).toEqual({ x: 100, y: 500 });
    expect(pts[pts.length - 1]).toEqual({ x: 1600, y: 380 });
    expect(() => kit.pathPoints("L 1 2")).toThrow(/M/);

    const tl = new FakeTimeline();
    const canvas = fakeCanvas();
    const opts = { path: "M100 500 C 400 200, 900 800, 1400 420", duration: 1, seed: 7 };
    expect(kit.brushStroke(tl, canvas, 2, opts)).toBe(3);
    const ink = (t: number): { lines: number; calls: string[] } => {
      canvas.calls = [];
      tl.seek(t);
      return {
        lines: canvas.calls.filter((c) => c.startsWith("lineTo")).length,
        calls: canvas.calls,
      };
    };
    expect(ink(0).lines).toBe(0);
    expect(ink(1.9).lines).toBe(0);
    const counts = [2.2, 2.5, 2.8, 3].map((t) => ink(t).lines);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]!);
    const mid = ink(2.5).calls;
    ink(3);
    ink(0);
    expect(ink(2.5).calls).toEqual(mid);
    // Another seed lays different bristles.
    const other = fakeCanvas();
    kit.brushStroke(tl, other, 2, { ...opts, seed: 8 });
    other.calls = [];
    tl.seek(2.5);
    expect(other.calls).not.toEqual(mid);
    expect(() => kit.brushStroke(tl, canvas, 0, { points: [{ x: 0, y: 0 }] })).toThrow(/points/);
    expect(() => kit.brushStroke(tl, canvas, 0, { ...opts, width: 0 })).toThrow(/width/);
  });

  it("prints spot inks: seeded halftone, multiply overprint, settling registration, paper", async () => {
    const kit = await loadKit();
    const tile = kit.halftoneTile({ seed: 3 });
    expect(tile.data).toHaveLength(tile.size * tile.size * 4);
    expect(kit.halftoneTile({ seed: 3 })).toEqual(tile);
    expect(kit.halftoneTile({ seed: 4 }).data).not.toEqual(tile.data);
    const coverage = (amount: number): number => {
      const { data } = kit.halftoneTile({ amount, seed: 3 });
      let ink = 0;
      for (let i = 3; i < data.length; i += 4) ink += data[i]! / 255;
      return ink / (data.length / 4);
    };
    const levels = [0.2, 0.4, 0.6, 0.85].map(coverage);
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]!);
    expect(levels[1]).toBeCloseTo(0.4, 1);

    const doc = { createElement: () => fakeCanvas(1, 1) };
    const ink = element();
    const url = kit.printInk(ink, { offset: { x: 3, y: -2 }, seed: 3, document: doc });
    expect(kit.printInk(element(), { offset: { x: 3, y: -2 }, seed: 3, document: doc })).toBe(url);
    expect(ink.style.mixBlendMode).toBe("multiply");
    expect(ink.style.translate).toBe("3px -2px");
    expect(ink.style.maskImage).toBe(`url(${url})`);
    expect(ink.style.maskSize).toBe(`${tile.size}px ${tile.size}px`);

    const tl = new FakeTimeline();
    const layers = [element(), element(), element()];
    const opts = { distance: 30, seed: 2 };
    const settle = kit.misregister(tl, layers, 1, opts);
    expect(settle).toBeGreaterThan(1);
    const shift = (t: number): Array<{ x: number; y: number }> => kit.misregisterAt(t - 1, 3, opts);
    const css = (p: { x: number; y: number }): string =>
      `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px)`;
    const start = shift(1);
    for (const p of start) expect(Math.hypot(p.x, p.y)).toBeGreaterThan(20);
    for (const p of shift(settle)) expect(Math.hypot(p.x, p.y)).toBeLessThan(0.1);
    const seen: Record<number, string[]> = {};
    for (const t of [1.3, 0, settle, 1.3, 9, 1, 1.15]) {
      tl.seek(t);
      const now = layers.map((l) => l.style.transform!);
      expect(now).toEqual(shift(t).map(css));
      if (seen[t]) expect(now).toEqual(seen[t]);
      seen[t] = now;
    }
    expect(kit.misregisterAt(0, 3, { ...opts, apart: true })[0]).toEqual({ x: 0, y: 0 });
    const from = [
      { x: 10, y: 0 },
      { x: -10, y: 4 },
    ];
    expect(kit.misregisterAt(0, 2, { from, ease: "glide", duration: 1 })).toEqual(from);

    const paper = kit.paperTile({ seed: 5, size: 64 });
    expect(kit.paperTile({ seed: 5, size: 64 })).toEqual(paper);
    expect(kit.paperTile({ seed: 6, size: 64 })).not.toEqual(paper);
    const one = element();
    const purl = kit.paperTexture(one, { seed: 5, size: 64, document: doc });
    expect(kit.paperTexture(element(), { seed: 5, size: 64, document: doc })).toBe(purl);
    expect(one.style.mixBlendMode).toBe("multiply");
    expect(one.style.backgroundImage).toBe(`url(${purl})`);

    expect(() => kit.halftoneTile({ amount: 0 })).toThrow(/amount/);
    expect(() => kit.halftoneTile({ cell: 1 })).toThrow(/cell/);
    expect(() => kit.printInk(element(), { offset: { x: "a" }, document: doc })).toThrow(/offset/);
    expect(() => kit.printInk(element(), {})).toThrow(/document/);
    expect(() => kit.misregister(tl, [], 0)).toThrow(/layer/);
    expect(() => kit.misregisterAt(0, 2, { from: [{ x: 1, y: 1 }] })).toThrow(/from/);
    expect(() => kit.misregisterAt(0, 1, { ease: "glide", duration: 0 })).toThrow(/duration/);
    expect(() => kit.paperTile({ amount: 2 })).toThrow(/amount/);
    expect(() => kit.paperTile({ tint: "beige" })).toThrow(/tint/);
  });
});
