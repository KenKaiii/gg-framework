import { useEffect, useRef, useState } from "react";
import { whatsNewLayout } from "./clearing-art";
import { createClearingScene, sceneHour } from "./clearing-scene";
import { lightAt } from "./scene-light";
import { useLocalHour } from "./use-local-hour";
import { useWindowFocused } from "./useWindowFocused";
import type { CSSProperties } from "react";
import title from "./assets/home/gg-coder-title.png";
import { HOME_TITLE_H, HOME_TITLE_W } from "./HomeTitle";
import { DoneButton, FeatureCopy, ReleaseHistory, type LoungeProps } from "./WhatsNewParts";

/**
 * The "What's new" window, drawn the way GG Royale draws its art (see
 * clearing-art.ts) but set in the home screen's world: the evening clearing
 * in the pines, lit for the local hour like the home screen, with a small
 * campfire on the grass that flickers, sends up embers and lights the grass,
 * with fireflies drifting over it. The gold "GG Coder" title, the notes on a
 * dark board and a plate button to leave sit over it.
 */

/** Screen px per art px, as in the game. */
const SCALE = 2;
/** How tall the patch of grass along the bottom is (art px): the plate sits on it. */
const GROUND_FROM_BOTTOM = 58;

/** The fire and fireflies step like the game's art: 12 frames a second is plenty. */
const FRAME_MS = 1000 / 12;
/** Where a still (reduced-motion) frame is taken. */
const STILL_SECONDS = 4;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The clearing behind everything. The still layer is painted once per size
 * and hour into a buffer; each frame copies it and paints the moving layer
 * (fire, embers, smoke, fireflies) on top. A window in the background stops
 * animating, and reduced motion shows one still frame.
 */
function Clearing({ hour }: { hour: number }): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  const focused = useWindowFocused();
  const [reduced] = useState(prefersReducedMotion);
  const [size, setSize] = useState(() => ({
    w: Math.ceil(window.innerWidth / SCALE),
    h: Math.ceil(window.innerHeight / SCALE),
  }));
  useEffect(() => {
    const onResize = (): void =>
      setSize({
        w: Math.ceil(window.innerWidth / SCALE),
        h: Math.ceil(window.innerHeight / SCALE),
      });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { w, h } = size;
    const light = lightAt(hour);
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w * SCALE}px`;
    canvas.style.height = `${h * SCALE}px`;
    ctx.imageSmoothingEnabled = false;
    const scene = createClearingScene(ctx, whatsNewLayout(w, h, GROUND_FROM_BOTTOM), light);
    if (!scene) return;
    const paint = (seconds: number): void => scene.paint(seconds);
    paint(STILL_SECONDS);
    if (reduced || !focused) return;
    let raf = 0;
    let last = -Infinity;
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      paint(now / 1000);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hour, size, reduced, focused]);

  return <canvas ref={ref} className="wn-backdrop" aria-hidden="true" />;
}

export function WhatsNewLounge({
  latest,
  earlier,
  mode,
  onClose,
  hour: fixedHour,
}: LoungeProps & {
  /** Light the clearing for this hour instead of the local clock (previews). */
  hour?: number;
}): React.ReactElement {
  const hype = mode === "hype";
  const localHour = useLocalHour();
  return (
    <div className="wn-lounge">
      <Clearing hour={sceneHour(fixedHour ?? localHour)} />
      <header className="wn-lounge-head">
        <h1 className="sr-only">{`What's new in GG Coder v${latest.version}`}</h1>
        <img
          className="wn-lounge-title"
          src={title}
          alt=""
          aria-hidden="true"
          width={HOME_TITLE_W}
          height={HOME_TITLE_H}
          draggable={false}
        />
        <p className="wn-lounge-version" aria-hidden="true">
          {`What's new in v${latest.version}`}
        </p>
      </header>
      <div className="wn-board">
        <div className="wn-board-scroll">
          <h2 className="wn-board-title">{hype ? "Fresh off the press" : "New this time"}</h2>
          <ol className="wn-rows" aria-label={`New in v${latest.version}`}>
            {latest.items.map((item, i) => (
              <li key={i} className="wn-row wn-row-in" style={{ "--i": i } as CSSProperties}>
                <span className="wn-tag" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="wn-row-copy">
                  <FeatureCopy item={item} />
                </div>
              </li>
            ))}
          </ol>
          <ReleaseHistory sections={earlier} delay={latest.items.length} />
        </div>
      </div>
      <footer className="wn-lounge-foot">
        <DoneButton label={hype ? "Let's go" : "Got it"} onClose={onClose} />
      </footer>
    </div>
  );
}
