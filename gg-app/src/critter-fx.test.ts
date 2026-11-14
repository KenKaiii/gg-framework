// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { discard } from "./critter-fx";
import { createCritterFloor } from "./critter-floor";
import { homeRoster } from "./home-roster";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("discard", () => {
  // WebKit keeps a detached node's fill-forwards/infinite animations on the
  // page timeline forever; only cancel() releases them. Removing without
  // cancelling leaked ~20% idle CPU per long-lived critter window.
  it("cancels the node's and its children's animations before removing it", () => {
    const parent = document.createElement("div");
    const node = document.createElement("div");
    parent.appendChild(node);
    const cancel = vi.fn();
    const getAnimations = vi.fn(() => [{ cancel }, { cancel }] as unknown as Animation[]);
    node.getAnimations = getAnimations;

    discard(node);

    expect(getAnimations).toHaveBeenCalledWith({ subtree: true });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(node.isConnected).toBe(false);
    expect(parent.childElementCount).toBe(0);
  });

  it("ignores a missing node", () => {
    expect(() => discard(null)).not.toThrow();
  });
});

describe("critter floor frame loop", () => {
  it("runs only while the window is focused, and resumes on focus", () => {
    vi.useFakeTimers();
    Element.prototype.animate = vi.fn(
      () =>
        ({
          finished: Promise.resolve(),
          cancel: () => undefined,
          onfinish: null,
        }) as unknown as Animation,
    ) as unknown as Element["animate"];
    Element.prototype.getAnimations = vi.fn(() => []) as unknown as Element["getAnimations"];
    let focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const lane = document.createElement("div");
    document.body.appendChild(lane);
    const floor = createCritterFloor(lane, { reducedMotion: true, ambient: true });

    floor.sync(homeRoster());
    vi.advanceTimersByTime(2000);
    expect(raf).toHaveBeenCalled();

    focused = false;
    window.dispatchEvent(new Event("blur"));
    expect(caf).toHaveBeenCalled();
    raf.mockClear();
    vi.advanceTimersByTime(5000);
    expect(raf).not.toHaveBeenCalled();

    focused = true;
    window.dispatchEvent(new Event("focus"));
    expect(raf).toHaveBeenCalledTimes(1);

    floor.destroy();
  });
});

/** A stand-in Web Animation: loops stay running, one-shots finish at once. */
interface FakeAnimation {
  readonly target: Element;
  readonly loops: boolean;
  playState: AnimationPlayState;
  currentTime: number;
  /** Ends a held one-shot (see `control.holdOneShots`). */
  finish?: () => void;
}

function fakeWebAnimations(control = { holdOneShots: false }): FakeAnimation[] {
  const all: FakeAnimation[] = [];
  Element.prototype.animate = function animate(
    this: Element,
    _frames: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ): Animation {
    const iterations = typeof options === "object" ? options.iterations : 1;
    const loops = iterations === Number.POSITIVE_INFINITY;
    const held = !loops && control.holdOneShots;
    const anim: FakeAnimation = {
      target: this,
      loops,
      playState: loops || held ? "running" : "finished",
      currentTime: 400,
    };
    all.push(anim);
    const finished = held
      ? new Promise<void>((resolve) => {
          anim.finish = () => {
            anim.playState = "finished";
            resolve();
          };
        })
      : loops
        ? new Promise<void>(() => undefined)
        : Promise.resolve();
    return Object.assign(anim, {
      effect: { getTiming: () => ({ iterations: iterations ?? 1 }) },
      finished,
      pause: () => {
        anim.playState = "paused";
      },
      play: () => {
        anim.playState = "running";
      },
      cancel: () => {
        anim.playState = "idle";
      },
    }) as unknown as Animation;
  } as Element["animate"];
  Element.prototype.getAnimations = function getAnimations(this: Element): Animation[] {
    return all.filter(
      (a) => a.playState !== "idle" && a.target.isConnected && this.contains(a.target),
    ) as unknown as Animation[];
  } as Element["getAnimations"];
  return all;
}

describe("critter floor in a background window", () => {
  const runningAgent = {
    key: "a1",
    agentName: undefined,
    critterId: "fox",
    label: "worker",
    status: "running" as const,
    activity: "Running pnpm test",
    tokens: null,
    durationMs: undefined,
    toolUseCount: 1,
  };

  function setup(startFocused: boolean) {
    vi.useFakeTimers();
    const control = { holdOneShots: false };
    const anims = fakeWebAnimations(control);
    const state = { focused: startFocused };
    vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const lane = document.createElement("div");
    document.body.appendChild(lane);
    // The classic beam in and out, and nothing happening by itself: these
    // tests are about resting, not the stage's shows (critter-stage.test.ts).
    const floor = createCritterFloor(lane, {
      reducedMotion: false,
      random: () => 0.5,
      stage: { arrival: "beam", exit: "beam", happenings: false },
    });
    const blur = (): void => {
      state.focused = false;
      window.dispatchEvent(new Event("blur"));
    };
    const focus = (): void => {
      state.focused = true;
      window.dispatchEvent(new Event("focus"));
    };
    return { anims, control, lane, floor, blur, focus };
  }
  const loopsIn = (anims: FakeAnimation[], state: AnimationPlayState) =>
    anims.filter((a) => a.loops && a.playState === state);

  it("rests work loops on their first frame and freezes the scripts until focus", async () => {
    const { anims, floor, blur, focus } = setup(true);
    floor.sync([runningAgent]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(loopsIn(anims, "running").length).toBeGreaterThan(0);

    blur();
    expect(loopsIn(anims, "running")).toEqual([]);
    const rested = loopsIn(anims, "paused");
    expect(rested.length).toBeGreaterThan(0);
    expect(rested.every((a) => a.currentTime === 0)).toBe(true);

    // Nothing moves while the user looks elsewhere: no new effects, no timers.
    const made = anims.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(anims.length).toBe(made);
    expect(vi.getTimerCount()).toBe(0);

    focus();
    expect(rested.every((a) => a.playState === "running" || a.playState === "idle")).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(anims.length).toBeGreaterThan(made);

    floor.destroy();
  });

  it("waits for in-flight one-shots without polling, then rests the loop they lead to", async () => {
    const { anims, control, lane, floor, blur } = setup(true);
    floor.sync([runningAgent]);
    await vi.advanceTimersByTimeAsync(3000);
    const critter = lane.querySelector(".critter");
    if (!critter) throw new Error("no critter");
    control.holdOneShots = true;
    critter.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    const oneShot = anims[anims.length - 1];

    blur();
    // A hidden page's one-shots don't advance, so a poll here would tick forever.
    expect(vi.getTimerCount()).toBe(0);

    // The one-shot's script moves on to a new loop as it ends...
    critter.animate([{ opacity: 1 }], { duration: 500, iterations: Infinity });
    oneShot?.finish?.();
    await vi.advanceTimersByTimeAsync(0);
    // ...and that loop rests too.
    expect(loopsIn(anims, "running")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    floor.destroy();
  });

  it("lands a new agent straight into a still working pose", async () => {
    const { anims, lane, floor } = setup(false);
    floor.sync([runningAgent]);
    await vi.advanceTimersByTimeAsync(0);

    expect(lane.querySelectorAll(".critter")).toHaveLength(1);
    expect(lane.querySelector(".critter.summoning")).toBeNull();
    expect(loopsIn(anims, "paused").length).toBeGreaterThan(0);
    expect(loopsIn(anims, "running")).toEqual([]);

    floor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
