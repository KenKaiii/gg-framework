import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * World's TVs play one YouTube video (Rick Astley). World itself is sealed (WorldScreen.tsx) and a sealed frame
 * can't play YouTube, so the app shows the video for it: the game says where the TV's glass is on screen and the app
 * lays a player exactly over it. The player is the World server's /tv page (gg-royale apps/world-server src/tv.ts),
 * because YouTube refuses embeds that send no Referer and this app (tauri://localhost) sends none. The app's CSP
 * allows that one origin in frame-src.
 *
 *   game -> app: { t:'tv', open:true, n, rect:{x,y,w,h,radius} } | { t:'tv-rect', n, rect } | { t:'tv', open:false }
 *   app -> game: { t:'tv-event', n, ev } with the TV page's own events ({gg:'tv', t:'ready'|'blocked'|'state', s})
 * Nothing loads until a TV is opened in the game; closing it (or leaving World) removes the player.
 */
export const TV_PAGE = "https://gg-world.buzzbeamaustralia.workers.dev/tv";
const TV_ORIGIN = new URL(TV_PAGE).origin;

type Rect = { x: number; y: number; w: number; h: number; radius: number };
export type TvState = { n: number; rect: Rect; ready: boolean } | null;

const num = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(lo, Math.min(hi, n));
};
const rectOf = (r: unknown): Rect | null => {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const rect = {
    x: num(o.x, 0, W),
    y: num(o.y, 0, H),
    w: num(o.w, 0, W),
    h: num(o.h, 0, H),
    radius: num(o.radius, 0, 60),
  };
  return rect.w >= 40 && rect.h >= 30 ? rect : null;
};

export type WorldTvApi = {
  state: TvState;
  frame: React.RefObject<HTMLIFrameElement | null>;
  /** Handle a message from the game; true when it was a TV message. */
  onGameMessage: (d: { t?: unknown; open?: unknown; n?: unknown; rect?: unknown }) => boolean;
};

export function useWorldTv(
  post: (msg: Record<string, unknown>) => void,
  refocusGame: () => void,
): WorldTvApi {
  const [state, setState] = useState<TvState>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const n = state?.n;

  // the TV page's events go to the game (only from the player we made, on the TV origin)
  useEffect(() => {
    if (n === undefined) return;
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== TV_ORIGIN || e.source !== frame.current?.contentWindow) return;
      const ev = e.data as { gg?: unknown; t?: unknown; s?: unknown } | null;
      if (!ev || ev.gg !== "tv" || typeof ev.t !== "string") return;
      if (ev.t === "ready") setState((s) => (s && s.n === n ? { ...s, ready: true } : s));
      // playing: a click on the player (autoplay fallback) left keyboard focus in it; give it back to the game
      if (ev.t === "state" && ev.s === 1) refocusGame();
      post({
        t: "tv-event",
        n,
        ev: { gg: "tv", t: ev.t, s: typeof ev.s === "number" ? ev.s : undefined },
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [n, post, refocusGame]);

  const onGameMessage = useCallback<WorldTvApi["onGameMessage"]>((d) => {
    if (d.t === "tv") {
      if (d.open === true) {
        const rect = rectOf(d.rect);
        const k = typeof d.n === "number" ? d.n : 0;
        setState(rect ? { n: k, rect, ready: false } : null);
      } else setState(null);
      return true;
    }
    if (d.t === "tv-rect") {
      const rect = rectOf(d.rect);
      setState((s) => (s && rect && d.n === s.n ? { ...s, rect } : s));
      return true;
    }
    return false;
  }, []);

  return useMemo(() => ({ state, frame, onGameMessage }), [state, onGameMessage]);
}

/** The player, laid over the TV's glass in the game. */
export function WorldTv({
  state,
  frameRef,
}: {
  state: TvState;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
}): React.ReactElement | null {
  if (!state) return null;
  return (
    <iframe
      key={state.n}
      ref={frameRef}
      className={`world-tv${state.ready ? " is-ready" : ""}`}
      aria-label="TV"
      src={`${TV_PAGE}?t=${state.n}`}
      // sealed: it may run its own scripts (YouTube needs them, and its own origin), but it can't take over the app
      // window (no top navigation), open pop-ups or show forms, whatever the page it loads does
      sandbox="allow-scripts allow-same-origin allow-presentation"
      allow="autoplay; encrypted-media"
      referrerPolicy="strict-origin-when-cross-origin"
      style={{
        left: state.rect.x,
        top: state.rect.y,
        width: state.rect.w,
        height: state.rect.h,
        borderRadius: state.rect.radius,
      }}
    />
  );
}
