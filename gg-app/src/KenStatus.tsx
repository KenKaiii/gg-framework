import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PixelGlyph } from "./PixelGlyph";
import { drawKenPortrait } from "./goal-ken-portrait";
import { LONG_THINK_MS, type KenStatus as Status } from "./goal-ken-status";
import { useMotionLevel } from "./window-motion";

interface Props {
  readonly status: Status;
  /** Out of the way: Ken is talking, or a sign is up (one thing at a time). */
  readonly away: boolean;
  readonly reducedMotion: boolean;
  /** Told when the pointer rests on the pill and when it leaves (Ken holds his lines meanwhile). */
  readonly onHoverChange?: (hovered: boolean) => void;
}

// The dissolve between moments (match App.css, .ken-status): the text fades
// out, the pill eases to its new size while it's hidden, and the new text
// fades in as the pill settles.
const FADE_OUT_MS = 90;
const MORPH_MS = 400;
const REVEAL_AT_MS = 260;
// A short grace before a hover opens or closes the pill, so brushing past it
// doesn't flicker it.
const HOVER_IN_MS = 60;
const HOVER_OUT_MS = 160;
const BLINK_EVERY_MS = 3400;
const BLINK_MS = 130;

/** How long a moment has lasted: "8s", "1m 28s", "12m". */
export function formatFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m >= 10) return `${m}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Everything the pill shows for a moment: a change of any of it is a new look. */
function lookOf(s: Status): string {
  return [s.key, s.tone, s.icon, s.face, s.headline, s.detail ?? "", s.timed, s.thinking].join("|");
}

/** Open: it opens by itself, or it's hovered and has a line to show. */
function wantsOpen(s: Status, hovered: boolean): boolean {
  return s.opens || (hovered && s.detail !== null);
}

function setFlag(el: HTMLElement, name: string, on: boolean): void {
  if (on) el.setAttribute(name, "");
  else el.removeAttribute(name);
}

/**
 * What Ken is doing right now, in one line, bottom right of the Workers view:
 * his face in a medallion, the kind of work as a badge on it, and how long
 * he's been at it. A pill in his storybook style (parchment, frame, serif)
 * that grows on hover to show one more line, what the headline doesn't say,
 * and opens by itself when something went wrong. Between moments the text
 * dissolves out and back in while the pill eases to its new size.
 *
 * It names a question or the end of a run without repeating them (the
 * farm's signs carry those), and it steps aside whenever Ken is talking or a
 * sign is up, so only one of them is ever on screen. Decoration for screen
 * readers: the Workers view's live summary says the same in words.
 *
 * Opening and closing only ever resize the pill; its text isn't touched.
 * Those are attributes the component sets itself on the root (data-open,
 * data-collapsing, data-slow, data-fading), outside React's render, so the
 * size before a change can be measured and eased from.
 */
export function KenStatus({
  status,
  away,
  reducedMotion,
  onHoverChange,
}: Props): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLParagraphElement>(null);
  const faceRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const motion = useMotionLevel();

  // The moment on show (the target lags it by the dissolve), and when it began.
  const [shown, setShown] = useState(status);
  const shownRef = useRef(shown);
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [blink, setBlink] = useState(false);

  const hoveredRef = useRef(false);
  const fromRef = useRef<DOMRect | null>(null);
  const timers = useRef({ fade: 0, reveal: 0, morph: 0, hover: 0 });
  const onHoverChangeRef = useRef(onHoverChange);
  useEffect(() => {
    onHoverChangeRef.current = onHoverChange;
  }, [onHoverChange]);
  useEffect(() => {
    const t = timers.current;
    return () => {
      window.clearTimeout(t.fade);
      window.clearTimeout(t.reveal);
      window.clearTimeout(t.morph);
      window.clearTimeout(t.hover);
    };
  }, []);

  /**
   * Ease the pill from `from` to the size it has now. The detail line is held
   * at its final width, so it never re-wraps as the pill grows. Interrupting
   * eases on from wherever the pill is. Returns whether the size changed.
   */
  const morphFrom = useCallback(
    (from: DOMRect, after?: () => void): boolean => {
      const card = cardRef.current;
      const detail = detailRef.current;
      if (!card) return false;
      window.clearTimeout(timers.current.morph);
      card.classList.remove("is-sizing");
      card.style.width = "";
      card.style.height = "";
      if (detail) detail.style.width = "";
      const to = card.getBoundingClientRect();
      if (
        reducedMotion ||
        (Math.abs(from.width - to.width) < 0.5 && Math.abs(from.height - to.height) < 0.5)
      ) {
        after?.();
        return false;
      }
      if (detail) detail.style.width = `${detail.getBoundingClientRect().width}px`;
      card.style.width = `${from.width}px`;
      card.style.height = `${from.height}px`;
      void card.offsetWidth;
      card.classList.add("is-sizing");
      card.style.width = `${to.width}px`;
      card.style.height = `${to.height}px`;
      timers.current.morph = window.setTimeout(() => {
        card.classList.remove("is-sizing");
        card.style.width = "";
        card.style.height = "";
        if (detail) detail.style.width = "";
        after?.();
      }, MORPH_MS + 20);
      return true;
    },
    [reducedMotion],
  );

  /** Open or close the pill's extra line: a resize only, nothing re-rendered. */
  const setOpen = useCallback(
    (open: boolean, animate: boolean): void => {
      const root = rootRef.current;
      const card = cardRef.current;
      if (!root || !card) return;
      if (root.hasAttribute("data-open") === open && !root.hasAttribute("data-collapsing")) return;
      const from = card.getBoundingClientRect();
      if (open || !animate || reducedMotion) {
        setFlag(root, "data-collapsing", false);
        setFlag(root, "data-open", open);
        if (animate) morphFrom(from);
        return;
      }
      // Closing: shrink to the closed size with the line still laid out (it
      // fades as the edge covers it), and drop it once the pill is closed.
      setFlag(root, "data-open", false);
      const closed = card.getBoundingClientRect();
      setFlag(root, "data-open", true);
      setFlag(root, "data-collapsing", true);
      card.style.width = `${from.width}px`;
      card.style.height = `${from.height}px`;
      void card.offsetWidth;
      card.classList.add("is-sizing");
      card.style.width = `${closed.width}px`;
      card.style.height = `${closed.height}px`;
      window.clearTimeout(timers.current.morph);
      timers.current.morph = window.setTimeout(() => {
        card.classList.remove("is-sizing");
        card.style.width = "";
        card.style.height = "";
        setFlag(root, "data-open", false);
        setFlag(root, "data-collapsing", false);
      }, MORPH_MS + 20);
    },
    [morphFrom, reducedMotion],
  );

  // A new moment: dissolve the text out, swap, ease the size, dissolve in.
  const look = lookOf(status);
  useEffect(() => {
    if (look === lookOf(shownRef.current)) return;
    const root = rootRef.current;
    const swap = (): void => {
      fromRef.current = cardRef.current?.getBoundingClientRect() ?? null;
      const keyChanged = status.key !== shownRef.current.key;
      shownRef.current = status;
      setShown(status);
      if (keyChanged) {
        const t = Date.now();
        setSince(t);
        setNow(t);
      }
    };
    window.clearTimeout(timers.current.fade);
    window.clearTimeout(timers.current.reveal);
    if (!root || reducedMotion || away) {
      if (root) setFlag(root, "data-fading", false);
      swap();
      return;
    }
    const alreadyOut = root.hasAttribute("data-fading");
    setFlag(root, "data-fading", true);
    timers.current.fade = window.setTimeout(swap, alreadyOut ? 0 : FADE_OUT_MS);
    // `status` is described by `look`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [look, reducedMotion, away]);

  // The new moment is in the page: set whether it's open, ease to its size,
  // and let the text back in.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const from = fromRef.current;
    fromRef.current = null;
    setFlag(root, "data-collapsing", false);
    setFlag(root, "data-open", wantsOpen(shown, hoveredRef.current));
    setFlag(root, "data-slow", shown.thinking && Date.now() - since >= LONG_THINK_MS);
    const moved = from ? morphFrom(from) : false;
    if (root.hasAttribute("data-fading")) {
      window.clearTimeout(timers.current.reveal);
      timers.current.reveal = window.setTimeout(
        () => setFlag(root, "data-fading", false),
        moved ? REVEAL_AT_MS : 0,
      );
    }
    // A new face: a little hop.
    const face = faceRef.current;
    if (face && !reducedMotion && !away) {
      face.classList.remove("is-hopping");
      void face.offsetWidth;
      face.classList.add("is-hopping");
    }
    // Only when the moment changes; `since` is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  // The clock, while there's a timer or a long think to watch for.
  const ticking = (shown.timed || shown.thinking) && !away && motion !== "off";
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  // A long think gets a reassuring line under the headline.
  const slow = shown.thinking && now - since >= LONG_THINK_MS;
  useLayoutEffect(() => {
    const root = rootRef.current;
    const card = cardRef.current;
    if (!root || !card || root.hasAttribute("data-slow") === slow) return;
    const from = card.getBoundingClientRect();
    setFlag(root, "data-slow", slow);
    if (!away) morphFrom(from);
  }, [slow, away, morphFrom]);

  // Stepping aside: whatever the pointer was doing, the pill goes back to rest.
  useEffect(() => {
    if (!away) return;
    window.clearTimeout(timers.current.hover);
    if (hoveredRef.current) {
      hoveredRef.current = false;
      onHoverChangeRef.current?.(false);
    }
    setOpen(wantsOpen(shownRef.current, false), false);
  }, [away, setOpen]);

  const onPointerEnter = (): void => {
    window.clearTimeout(timers.current.hover);
    timers.current.hover = window.setTimeout(() => {
      if (away || hoveredRef.current) return;
      hoveredRef.current = true;
      onHoverChangeRef.current?.(true);
      setOpen(wantsOpen(shownRef.current, true), true);
    }, HOVER_IN_MS);
  };
  const onPointerLeave = (): void => {
    window.clearTimeout(timers.current.hover);
    timers.current.hover = window.setTimeout(() => {
      if (!hoveredRef.current) return;
      hoveredRef.current = false;
      onHoverChangeRef.current?.(false);
      setOpen(wantsOpen(shownRef.current, false), true);
    }, HOVER_OUT_MS);
  };

  // His face for the moment; he blinks now and then while he's in view.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) drawKenPortrait(canvas, shown.face, { plain: true, blink });
  }, [shown.face, blink]);
  useEffect(() => {
    if (reducedMotion || away || motion === "off") return;
    let open = 0;
    const id = window.setInterval(() => {
      setBlink(true);
      open = window.setTimeout(() => setBlink(false), BLINK_MS);
    }, BLINK_EVERY_MS);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(open);
      setBlink(false);
    };
  }, [reducedMotion, away, motion]);

  const bar = shown.icon === "run" ? "run" : shown.icon === "wait" ? "wait" : undefined;
  return (
    <div
      ref={rootRef}
      className="ken-status"
      data-away={away ? "" : undefined}
      data-tone={shown.tone}
      data-icon={shown.icon}
      data-bar={bar}
      aria-hidden="true"
    >
      <div
        ref={cardRef}
        className="ken-status-card"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <div className="ken-status-head">
          <span ref={faceRef} className="ken-status-face">
            <canvas ref={canvasRef} />
          </span>
          <span className="ken-status-badge">
            <span key={shown.icon} className="ken-status-badge-icon">
              <PixelGlyph name={shown.icon} size={18} />
            </span>
          </span>
          <div className="ken-status-main">
            <div className="ken-status-top">
              <span className="ken-status-headline">{shown.headline}</span>
              {shown.thinking && (
                <span className="ken-status-dots">
                  <i />
                  <i />
                  <i />
                </span>
              )}
              {shown.timed && <span className="ken-status-time">{formatFor(now - since)}</span>}
            </div>
            {shown.detail && (
              <div className="ken-status-row ken-status-detail-row">
                <p ref={detailRef} className="ken-status-detail">
                  {shown.detail}
                </p>
              </div>
            )}
            <div className="ken-status-row ken-status-note-row">
              <p className="ken-status-note">
                <PixelGlyph name="clock" />
                Long think. Normal for a big step.
              </p>
            </div>
          </div>
        </div>
        <span className="ken-status-bar" />
      </div>
    </div>
  );
}
