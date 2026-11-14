// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCritterFloor, type FloorAgent, type FloorAgentStatus } from "./critter-floor";
import { ARRIVALS, EXITS, type StageOptions } from "./critter-types";

// jsdom has no Web Animations. This stand-in runs each one for its real
// length on the (fake) clock, so a show plays out in order: one-shots finish
// (and say so, since effects remove themselves on finish), loops run until
// cancelled, and getAnimations finds whatever is still going.
interface FakeAnimation {
  readonly target: Element;
  playState: AnimationPlayState;
  currentTime: number;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
  cancel(): void;
}
function fakeWebAnimations(): void {
  const live = new Set<FakeAnimation>();
  Element.prototype.animate = function animate(
    this: Element,
    _frames: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ): Animation {
    const o = typeof options === "number" ? { duration: options } : (options ?? {});
    const iterations = o.iterations ?? 1;
    const loops = iterations === Number.POSITIVE_INFINITY;
    let settle: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => (settle = resolve));
    const end = (state: AnimationPlayState): void => {
      anim.playState = state;
      live.delete(anim);
      settle();
    };
    const timer = loops
      ? undefined
      : setTimeout(
          () => {
            end("finished");
            anim.onfinish?.();
          },
          (Number(o.duration) || 0) * iterations + (o.delay ?? 0),
        );
    const anim: FakeAnimation = {
      target: this,
      playState: "running",
      currentTime: 0,
      onfinish: null,
      oncancel: null,
      cancel() {
        if (!live.has(anim)) return;
        clearTimeout(timer);
        end("idle");
        anim.oncancel?.();
      },
    };
    live.add(anim);
    return Object.assign(anim, {
      finished,
      effect: { getTiming: () => ({ iterations }) },
      pause: () => void (anim.playState = "paused"),
      play: () => void (anim.playState = "running"),
    }) as unknown as Animation;
  } as Element["animate"];
  Element.prototype.getAnimations = function getAnimations(
    this: Element,
    options?: GetAnimationsOptions,
  ): Animation[] {
    return [...live].filter(
      (a) => a.target === this || (options?.subtree === true && this.contains(a.target)),
    ) as unknown as Animation[];
  } as Element["getAnimations"];
}

let focused = true;
beforeEach(() => {
  vi.useFakeTimers();
  fakeWebAnimations();
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  // A lane wide enough for a monster, and for Ken to square up to it.
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(900);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

const agent = (
  key: string,
  status: FloorAgentStatus = "running",
  activity?: string,
): FloorAgent => ({
  key,
  agentName: undefined,
  label: key,
  status,
  activity,
  tokens: null,
  durationMs: undefined,
  toolUseCount: activity ? 1 : 0,
});
const crew = (keys: string, status: FloorAgentStatus = "running"): FloorAgent[] =>
  [...keys].map((key) => agent(key, status));

/** A fixed sequence of rolls, so a run plays the same way every time. */
function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function setup(
  stage: StageOptions,
  extra: { reducedMotion?: boolean; random?: () => number } = {},
) {
  const lane = document.createElement("div");
  document.body.appendChild(lane);
  const floor = createCritterFloor(lane, {
    reducedMotion: extra.reducedMotion ?? false,
    random: extra.random ?? seeded(),
    stage,
  });
  const count = (selector: string): number => lane.querySelectorAll(selector).length;
  return { lane, floor, count };
}
const run = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);
const blur = (): void => {
  focused = false;
  window.dispatchEvent(new Event("blur"));
};
const focus = (): void => {
  focused = true;
  window.dispatchEvent(new Event("focus"));
};

/** Everything the stage puts on the floor that isn't a critter. */
const PROPS =
  ".critter-thing, .critter-chute, .critter-balloon, .critter-soul, .critter-pow, " +
  ".critter-twinkle, .critter-rain, .critter-bolt, .critter-star, .critter-floor > .critter-pt";

describe("arrivals", () => {
  it.each(ARRIVALS)("%s lands its critters and clears up after itself", async (arrival) => {
    const { floor, count, lane } = setup({ arrival, happenings: false });
    floor.sync(crew("abc"));
    await run(15_000);
    expect(count(".critter")).toBe(3);
    expect(count(".critter.summoning")).toBe(0);
    expect(count(PROPS)).toBe(0);
    // Nobody left hidden, clipped or off in the wings.
    for (const react of lane.querySelectorAll<HTMLElement>(".critter-react")) {
      expect(react.style.opacity).toBe("");
      expect(react.style.clipPath).toBe("");
    }
    for (const c of lane.querySelectorAll<HTMLElement>(".critter")) {
      expect(c.style.clipPath).toBe("");
    }
    floor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("beams out the classic way a critter called away before it has landed", async () => {
    const { floor, count } = setup({ arrival: "ufo", exit: "balloon", happenings: false });
    floor.sync(crew("ab"));
    // The first is still waiting on the saucer when their agents finish.
    await run(300);
    expect(count(".critter.summoning")).toBe(1);
    floor.sync(crew("ab", "done"));
    expect(count(".critter-balloon")).toBe(0);
    await run(8000);
    expect(count(".critter")).toBe(0);
    expect(count(PROPS)).toBe(0);
    floor.destroy();
  });
});

describe("exits", () => {
  it.each(EXITS)("%s takes everyone who finished together off the floor", async (exit) => {
    const { floor, count, lane } = setup({ arrival: "beam", exit, happenings: false });
    floor.sync(crew("abc"));
    await run(2000);
    expect(count(".critter")).toBe(3);

    floor.sync(crew("abc", "done"));
    expect(count(".critter.leaving")).toBe(3);
    await run(25_000);
    expect(count(".critter")).toBe(0);
    expect(count(PROPS)).toBe(0);
    expect(lane.classList.contains("open")).toBe(false);
    // Nothing left ticking on an empty floor.
    expect(vi.getTimerCount()).toBe(0);
    floor.destroy();
  });

  it("sends off someone called back without a show", async () => {
    const { floor, count } = setup({ arrival: "beam", happenings: false });
    floor.sync(crew("a"));
    await run(2000);
    floor.sync(crew("a", "interrupted"));
    await run(400);
    // A puff, a hole or the beam: never a saucer, a bird or a monster.
    expect(count(".critter-ufo, .critter-monster, .critter-balloon")).toBe(0);
    await run(8000);
    expect(count(".critter")).toBe(0);
    floor.destroy();
  });
});

describe("the monster and Ken", () => {
  /** Step time until `done()`, or fail after `limit` ms. */
  async function until(done: () => boolean, limit: number, step = 100): Promise<void> {
    for (let t = 0; t < limit && !done(); t += step) await run(step);
    expect(done()).toBe(true);
  }

  it("brings Ken for an audience, lets them cheer, and leaves nothing behind", async () => {
    const { floor, count, lane } = setup({
      arrival: "beam",
      exit: "beam",
      happenings: ["ken"],
      tall: true,
    });
    floor.sync(crew("abc"));
    await until(() => count(".critter-monster") === 1, 20_000);
    await until(() => count(".critter-ken") === 1, 20_000);
    expect(count(".critter.shiver")).toBe(3);
    // Once he has landed the crowd is up and watching, not hiding.
    await run(2000);
    expect(count(".critter.shiver")).toBe(0);

    // He always wins: the monster goes first, then he does.
    await until(() => count(".critter-monster") === 0, 60_000);
    expect(count(".critter-ken")).toBe(1);
    await until(() => count(".critter-ken") === 0, 20_000);
    expect(count(".critter")).toBe(3);
    await run(3000);
    expect(count(PROPS)).toBe(0);
    expect(lane.querySelector(".critter-things .critter-bubble")).toBeNull();

    floor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never sends Ken when nobody is staying to watch, and clears the chased as they go", async () => {
    // Every roll comes up 0, so any chance Ken has, he takes.
    const { floor, count, lane } = setup(
      { arrival: "beam", exit: "monster", happenings: false, tall: true },
      { random: () => 0 },
    );
    floor.sync(crew("ab"));
    await run(2000);
    floor.sync(crew("ab", "done"));
    await until(() => count(".critter-monster") === 1, 5000);

    let goneWhileItWalked = false;
    for (let t = 0; t < 40_000 && count(".critter-monster") === 1; t += 100) {
      await run(100);
      expect(count(".critter-ken")).toBe(0);
      if (count(".critter") === 0 && count(".critter-monster") === 1) {
        goneWhileItWalked = true;
        // The lane stays open under the monster until it has gone too.
        expect(lane.classList.contains("open")).toBe(true);
      }
    }
    expect(goneWhileItWalked).toBe(true);
    expect(count(".critter-monster")).toBe(0);
    await run(5000);
    expect(lane.classList.contains("open")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    floor.destroy();
  });

  it("sends Ken when the monster chases some off and others stay", async () => {
    const { floor, count } = setup(
      { arrival: "beam", exit: "monster", happenings: false, tall: true },
      { random: () => 0 },
    );
    floor.sync(crew("abc"));
    await run(2000);
    floor.sync([agent("a", "done"), agent("b"), agent("c")]);
    await until(() => count(".critter-ken") === 1, 20_000);
    // The one it chased is long gone; the two who stayed are still here.
    expect(count(".critter")).toBe(2);
    await until(() => count(".critter-ken") === 0, 90_000);
    expect(count(".critter-monster")).toBe(0);
    floor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("reduced motion", () => {
  it("keeps the tag and static emotes, and nothing else of the stage", async () => {
    const { floor, count, lane } = setup({ tall: true }, { reducedMotion: true });
    floor.sync(crew("abc"));
    await run(60_000);
    expect(count(".critter")).toBe(3);
    expect(count(PROPS)).toBe(0);
    expect(count(".critter-blink, .critter-hat")).toBe(0);

    // A click still answers, with a still emote, and pins the tag.
    lane.querySelector<HTMLElement>(".critter")?.click();
    expect(count(".critter-emote")).toBe(1);
    expect(lane.querySelector(".critter-tag-name")?.textContent).toMatch(/^[abc]$/);

    // And it leaves by fading, whatever the stage would have done.
    floor.sync(crew("abc", "done"));
    await run(3000);
    expect(count(".critter")).toBe(0);
    expect(count(PROPS)).toBe(0);
    floor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a resting window", () => {
  it("starts no arrival, exit or happening, and applies agent changes at once", async () => {
    focused = false;
    const { floor, count } = setup({ arrival: "ufo", exit: "bird", happenings: ["ball"] });
    floor.sync(crew("ab"));
    await run(0);
    expect(count(".critter")).toBe(2);
    expect(count(".critter.summoning")).toBe(0);
    await run(120_000);
    expect(count(PROPS)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    floor.sync([agent("a", "done"), agent("b")]);
    expect(count(".critter")).toBe(1);
    expect(count(PROPS)).toBe(0);
    floor.destroy();
  });

  it("freezes a show part-way and picks it up on focus", async () => {
    const { floor, count } = setup({ arrival: "beam", exit: "ufo", happenings: false });
    floor.sync(crew("ab"));
    await run(2000);
    floor.sync(crew("ab", "done"));
    await run(400);
    expect(count(".critter-ufo")).toBe(1);

    blur();
    await run(120_000);
    // Just as it was: the saucer out, both still waiting for it.
    expect(count(".critter-ufo")).toBe(1);
    expect(count(".critter")).toBe(2);
    expect(vi.getTimerCount()).toBe(0);

    focus();
    await run(15_000);
    expect(count(".critter")).toBe(0);
    expect(count(PROPS)).toBe(0);
    floor.destroy();
  });
});

describe("the name tag", () => {
  const hover = (el: Element | null, type: "mouseenter" | "mouseleave"): void => {
    el?.dispatchEvent(new MouseEvent(type));
  };

  it("names the agent and says what it's doing while pointed at", async () => {
    const { floor, lane } = setup({ arrival: "beam", happenings: false });
    floor.sync([agent("worker", "running", "Reading src/auth/session.ts")]);
    await run(1500);
    const critter = lane.querySelector(".critter");
    hover(critter, "mouseenter");
    expect(lane.querySelector(".critter-tag-name")?.textContent).toBe("worker");
    expect(lane.querySelector(".critter-tag-text")?.textContent).toBe("Reading session.ts");
    expect(critter?.classList.contains("tagged")).toBe(true);

    // It follows the agent while it's up.
    floor.sync([agent("worker", "running", "Running pnpm test")]);
    await run(100);
    expect(lane.querySelector(".critter-tag-text")?.textContent).toBe("Running pnpm test");

    hover(critter, "mouseleave");
    expect(lane.querySelector(".critter-tag")).toBeNull();
    expect(critter?.classList.contains("tagged")).toBe(false);
    floor.destroy();
  });

  it("stays up a moment after a click, and comes off a critter that leaves", async () => {
    const { floor, lane, count } = setup({ arrival: "beam", exit: "beam", happenings: false });
    floor.sync(crew("ab"));
    await run(1500);
    const [first, second] = [...lane.querySelectorAll<HTMLElement>(".critter")];
    first?.click();
    expect(first?.querySelector(".critter-tag")).not.toBeNull();
    await run(2000);
    expect(count(".critter-tag")).toBe(1);
    await run(1000);
    expect(count(".critter-tag")).toBe(0);

    second?.click();
    expect(count(".critter-tag")).toBe(1);
    floor.sync(crew("ab", "done"));
    expect(count(".critter-tag")).toBe(0);
    floor.destroy();
  });
});
