// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatLayoutMotion } from "./chat-layout-motion";

function harness(count = 8, scale = 1) {
  const transcript = document.createElement("div");
  const surface = document.createElement("div");
  document.body.append(transcript, surface);
  let viewportHeight = 300;
  let surfaceTop = 300;
  // What a glide in flight adds to every displayed position; ending it clears that.
  const flight = { offset: 0 };
  const rect = (top: number, height: number) =>
    ({
      top: top * scale,
      bottom: (top + height) * scale,
      left: 0,
      width: 400 * scale,
      height: height * scale,
    }) as DOMRect;
  Object.defineProperties(transcript, {
    clientHeight: { get: () => viewportHeight },
    clientWidth: { value: 400 },
    scrollHeight: { get: () => count * 100 },
  });
  transcript.getBoundingClientRect = () => rect(0, viewportHeight);
  const started: { node: HTMLElement; frames: Keyframe[]; animation: Animation }[] = [];
  const setupAnimation = (node: HTMLElement) => {
    node.animate = vi.fn((frames: Keyframe[] | PropertyIndexedKeyframes | null) => {
      const animation = {
        cancel: vi.fn(() => {
          flight.offset = 0;
        }),
        onfinish: null,
        oncancel: null,
        effect: { setKeyframes: vi.fn() },
      } as unknown as Animation;
      started.push({ node, frames: frames as Keyframe[], animation });
      return animation;
    });
    Object.defineProperty(node, "offsetWidth", { value: 400 });
  };
  const rows = Array.from({ length: count }, (_, i) => {
    const node = document.createElement("div");
    transcript.append(node);
    Object.defineProperty(node, "offsetTop", { value: i * 100 });
    node.getBoundingClientRect = vi.fn(() =>
      rect(i * 100 - transcript.scrollTop + flight.offset, 100),
    );
    setupAnimation(node);
    return node;
  });
  surface.getBoundingClientRect = () => rect(surfaceTop + flight.offset, 100);
  setupAnimation(surface);
  transcript.scrollTop = count * 100 - viewportHeight;
  const motion = createChatLayoutMotion(() => ({ transcript, surfaces: [surface] }));
  const follow = vi.fn(() => {
    transcript.scrollTop = transcript.scrollHeight - transcript.clientHeight;
  });
  return {
    transcript,
    surface,
    rows,
    started,
    motion,
    follow,
    /** Put every glide `offset` px short of its destination, as the browser would show it. */
    midFlight(offset: number, paddingBottom = 0) {
      flight.offset = offset;
      vi.spyOn(window, "getComputedStyle").mockImplementation(
        () =>
          ({
            translate: `0px ${offset}px`,
            paddingBottom: `${paddingBottom}px`,
          }) as CSSStyleDeclaration,
      );
    },
    resize(height: number) {
      viewportHeight = height;
      surfaceTop = height;
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat layout transaction", () => {
  it.each([0.5, 0.95, 1, 1.25, 1.5, 2])(
    "pins final geometry before translating existing rows at zoom %s",
    (scale) => {
      const h = harness(8, scale);
      h.motion.capture();
      h.resize(200);
      const newcomer = document.createElement("div");
      newcomer.animate = vi.fn();
      h.transcript.append(newcomer);
      h.motion.commit(true, h.follow);
      expect(h.follow).toHaveBeenCalledOnce();
      expect(h.transcript.scrollTop).toBe(600);
      expect(h.started).toHaveLength(4);
      for (const { frames } of h.started) {
        expect(frames).toEqual([{ translate: "0px 100px" }, { translate: "0px 0px" }]);
      }
      expect(newcomer.animate).not.toHaveBeenCalled();
      // The observer for this exact commit must not re-pin/cancel a frame later.
      expect(h.motion.resized()).toBe(false);
      for (const { animation } of h.started)
        animation.onfinish?.call(animation, {} as AnimationPlaybackEvent);
      expect(h.transcript.scrollTop).toBe(600);
      h.motion.cancel();
      for (const { animation } of h.started) expect(animation.cancel).not.toHaveBeenCalled();
    },
  );

  it("holds an unpinned reader's row and offset without following", () => {
    const h = harness();
    h.transcript.scrollTop = 230;
    h.motion.capture();
    h.resize(400);
    h.transcript.scrollTop = 220; // model an intervening browser anchor adjustment
    h.motion.commit(false, h.follow);
    expect(h.transcript.scrollTop).toBe(230);
    expect(h.follow).not.toHaveBeenCalled();
    expect(h.started.map((s) => s.node)).toEqual([h.surface]);
  });

  it("rebases a reversal from what is visible, not the old destination", () => {
    const h = harness();
    h.motion.capture();
    h.resize(200);
    h.motion.commit(true, h.follow);
    const old = [...h.started];
    // 75ms into the surface movement it is displayed at y=260.
    h.surface.getBoundingClientRect = () =>
      ({ left: 0, top: 260, bottom: 360, width: 400, height: 100 }) as DOMRect;
    h.motion.capture();
    h.resize(300);
    h.surface.getBoundingClientRect = () =>
      ({ left: 0, top: 300, bottom: 400, width: 400, height: 100 }) as DOMRect;
    h.motion.commit(true, h.follow);
    for (const { animation } of old) expect(animation.cancel).toHaveBeenCalledOnce();
    expect(h.started[h.started.length - 1]?.frames).toEqual([
      { translate: "0px -40px" },
      { translate: "0px 0px" },
    ]);
    h.motion.cancel();
    expect(h.started[h.started.length - 1]?.animation.cancel).toHaveBeenCalledOnce();
  });

  it("gives a glide in its fast stretch the new destination without restarting it", () => {
    // Regression: a send's glide was cancelled and restarted when the queue
    // strip or run start landed a few frames in, stalling the rows mid-move.
    const h = harness();
    h.motion.capture();
    h.resize(200);
    h.motion.commit(true, h.follow);
    const first = [...h.started];
    h.midFlight(50); // half of the 100px still ahead
    h.motion.capture();
    expect(h.motion.capturing()).toBe(true);
    h.resize(150);
    h.motion.commit(true, h.follow);
    expect(h.motion.capturing()).toBe(false);
    expect(h.started).toHaveLength(first.length);
    for (const { animation } of first) {
      expect(animation.cancel).not.toHaveBeenCalled();
      // Displayed now: 50px in flight + 50px of new layout = 100px, at half
      // progress on the same clock, so the first keyframe doubles.
      expect(vi.mocked((animation.effect as KeyframeEffect).setKeyframes).mock.lastCall).toEqual([
        [{ translate: "0px 200px" }, { translate: "0px 0px" }],
      ]);
    }
  });

  it("starts from where the rows are now, not where a capture a frame old saw them", () => {
    // Regression: a capture can wait a frame or two for its render. Used as
    // read, it pulled rows back to where they had been and replayed the move.
    const h = harness();
    h.motion.capture();
    h.resize(200);
    h.motion.commit(true, h.follow);
    const first = [...h.started];
    h.midFlight(80);
    h.motion.capture();
    h.midFlight(50); // the glide carried on while the render was pending
    h.resize(150);
    h.motion.commit(true, h.follow);
    // 50px still in flight + 50px of new layout, at half progress.
    for (const { animation } of first) {
      expect(vi.mocked((animation.effect as KeyframeEffect).setKeyframes).mock.lastCall).toEqual([
        [{ translate: "0px 200px" }, { translate: "0px 0px" }],
      ]);
    }
  });

  it("suspends scroll anchoring for exactly as long as rows are in flight", () => {
    // Regression: WebKit's scroll anchoring took the displaced rows for a
    // layout shift and scrolled a pinned chat up after the glide, unpinning it.
    const h = harness();
    expect(h.transcript.hasAttribute("data-gliding")).toBe(false);
    h.motion.capture();
    h.resize(200);
    h.motion.commit(true, h.follow);
    expect(h.transcript.hasAttribute("data-gliding")).toBe(true);
    for (const { animation } of h.started.slice(1))
      animation.onfinish?.call(animation, {} as AnimationPlaybackEvent);
    expect(h.transcript.hasAttribute("data-gliding")).toBe(true);
    const [{ animation: last }] = h.started;
    last.onfinish?.call(last, {} as AnimationPlaybackEvent);
    expect(h.transcript.hasAttribute("data-gliding")).toBe(false);
    h.motion.capture();
    h.resize(300);
    h.motion.commit(true, h.follow);
    expect(h.transcript.hasAttribute("data-gliding")).toBe(true);
    h.motion.cancel();
    expect(h.transcript.hasAttribute("data-gliding")).toBe(false);
  });

  it("restarts a glide that has all but arrived", () => {
    const h = harness();
    h.motion.capture();
    h.resize(200);
    h.motion.commit(true, h.follow);
    const first = [...h.started];
    h.midFlight(2);
    h.motion.capture();
    h.resize(150);
    h.motion.commit(true, h.follow);
    for (const { animation } of first) expect(animation.cancel).toHaveBeenCalledOnce();
    expect(h.started.slice(first.length).map((s) => s.frames[0])).toContainEqual({
      translate: "0px 52px",
    });
  });

  it("lets a follow read scroll geometry without ending the glide", () => {
    // Regression: every follow cancelled the glide, so a dock that resized
    // during a send snapped the chat the rest of the way in one frame.
    const h = harness();
    h.motion.capture();
    h.resize(200);
    h.motion.commit(true, h.follow);
    h.midFlight(100, 141);
    const read = vi.fn();
    h.motion.still(read);
    expect(read).toHaveBeenCalledOnce();
    for (const { animation } of h.started) expect(animation.cancel).not.toHaveBeenCalled();
  });

  it("ends a glide displaced past the end of the content before a follow reads", () => {
    // That far down the last row stretches the scroll height, and the follow would overshoot.
    const h = harness();
    h.motion.capture();
    h.resize(200);
    h.motion.commit(true, h.follow);
    h.midFlight(100, 40);
    const read = vi.fn(() => {
      for (const { animation } of h.started) expect(animation.cancel).toHaveBeenCalledOnce();
    });
    h.motion.still(read);
    expect(read).toHaveBeenCalledOnce();
  });

  it("leaves a dock surface that only grew upward where it is", () => {
    // Its bottom edge held, so its top moving is a resize: translating it
    // would bob the composer's own content down and back.
    const h = harness();
    h.surface.getBoundingClientRect = () =>
      ({ left: 0, top: 300, bottom: 400, width: 400, height: 100 }) as DOMRect;
    h.motion.capture();
    h.surface.getBoundingClientRect = () =>
      ({ left: 0, top: 260, bottom: 400, width: 400, height: 140 }) as DOMRect;
    h.motion.commit(true, h.follow);
    expect(h.started.map((s) => s.node)).not.toContain(h.surface);
  });

  it("coalesces captures, cancels on resize/manual input and discards uncommitted snapshots", () => {
    const h = harness();
    h.motion.capture();
    h.resize(250);
    h.motion.capture();
    h.motion.commit(true, h.follow);
    expect(h.started[0]?.frames[0]).toEqual({ translate: "0px 50px" });
    h.resize(200);
    expect(h.motion.resized()).toBe(true);
    for (const { animation } of h.started) expect(animation.cancel).toHaveBeenCalledOnce();
    h.motion.capture();
    h.motion.cancel();
    h.motion.commit(true, h.follow);
    expect(h.follow).toHaveBeenCalledOnce();
  });

  it.each(["reduced", "missing", "unmounted"])("settles without motion when %s", (environment) => {
    const h = harness();
    if (environment === "reduced") vi.stubGlobal("matchMedia", () => ({ matches: true }));
    if (environment === "missing") {
      for (const node of [...h.rows, h.surface]) Reflect.deleteProperty(node, "animate");
    }
    h.motion.capture();
    h.resize(200);
    if (environment === "unmounted") h.transcript.remove();
    h.motion.commit(true, h.follow);
    expect(h.started).toEqual([]);
    expect(h.follow).toHaveBeenCalledTimes(environment === "unmounted" ? 0 : 1);
  });

  it("expires an uncommitted capture after two frames and cancels its expiry on teardown", () => {
    let expire: FrameRequestCallback | undefined;
    const request = vi.fn((callback: FrameRequestCallback) => {
      expire = callback;
      return 7;
    });
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const h = harness();
    h.motion.capture();
    expire?.(16);
    expire?.(32);
    expect(h.motion.commit(true, h.follow)).toBe(false);
    expect(h.follow).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    h.motion.capture();
    h.motion.cancel();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("still commits a capture whose render lands one frame later", () => {
    // Regression: a sidecar event or a timer renders in a later task. When a
    // frame fell in between, the capture had expired and nothing glided.
    let expire: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      expire = callback;
      return 7;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const h = harness();
    h.motion.capture();
    expire?.(16);
    h.resize(200);
    expect(h.motion.commit(true, h.follow)).toBe(true);
    expect(h.started.length).toBeGreaterThan(0);
  });

  it("bounds reads to the visible tail rather than measuring all history", () => {
    const h = harness(500);
    h.motion.capture();
    const reads = h.rows.reduce(
      (sum, row) => sum + vi.mocked(row.getBoundingClientRect).mock.calls.length,
      0,
    );
    expect(reads).toBeLessThan(16); // binary search + three visible rows
    h.motion.cancel();
  });
});
