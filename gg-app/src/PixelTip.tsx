import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * GG Royale's tooltip, for the app's pixel screens (Home): a small gold card
 * in m5x7, ink lettering, with "Name:" picked out in the game's blue when the
 * text starts with one ("Settings: providers, ..."). Shown on hover and on
 * keyboard focus, after a short pause; hidden on leave, blur, press or Esc.
 * Wraps one control, which keeps its own accessible name: the tip is added as
 * its description while it shows. The wrapper is display: contents, so the
 * control lays out exactly as before.
 *
 * Drawn like the game's (apps/client/blackjack/blackjack.css, .tip-body) at
 * 2 screen pixels per art pixel.
 */
const SHOW_AFTER_MS = 350;

export function PixelTip({
  text,
  children,
}: {
  text: string;
  children: React.ReactNode;
}): React.ReactElement {
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();

  const show = (el: Element): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      // Under the element, unless that runs off the bottom of the window.
      const below = r.bottom + 64 < window.innerHeight;
      setAt({ x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
    }, SHOW_AFTER_MS);
  };
  const hide = (): void => {
    window.clearTimeout(timer.current);
    setAt(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Keep the tip inside the window: nudge it in from either edge once it's
  // measured (it's centred on the control, so near a corner it would spill).
  useEffect(() => {
    const tip = tipRef.current;
    if (!at || !tip) return;
    const r = tip.getBoundingClientRect();
    const margin = 8;
    const shift =
      r.right > window.innerWidth - margin
        ? window.innerWidth - margin - r.right
        : r.left < margin
          ? margin - r.left
          : 0;
    if (shift) tip.style.left = `${at.x + shift}px`;
  }, [at]);

  // The wrapped control is described by the tip while it shows.
  useEffect(() => {
    const el = wrap.current?.firstElementChild;
    if (!el) return;
    if (at)
      el.setAttribute(
        "aria-describedby",
        [el.getAttribute("aria-describedby"), id].filter(Boolean).join(" "),
      );
    return () => {
      const rest = (el.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .filter((t) => t && t !== id);
      if (rest.length) el.setAttribute("aria-describedby", rest.join(" "));
      else el.removeAttribute("aria-describedby");
    };
  }, [at, id]);

  const m = /^([A-Z][^:.]{1,22}):\s(.*)$/s.exec(text);

  return (
    <span
      ref={wrap}
      className="pixel-tip-anchor"
      onPointerEnter={(e) =>
        e.currentTarget.firstElementChild && show(e.currentTarget.firstElementChild)
      }
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => {
        if (e.target.matches(":focus-visible")) show(e.target);
      }}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === "Escape") hide();
      }}
    >
      {children}
      {at &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className={`pixel-tip${at.below ? "" : " is-above"}`}
            style={{ left: at.x, top: at.y }}
          >
            {m ? (
              <>
                <span className="pixel-tip-key">{m[1]}</span>: {m[2]}
              </>
            ) : (
              text
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
