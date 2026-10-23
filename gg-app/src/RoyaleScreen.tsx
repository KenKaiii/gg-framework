import { useCallback, useEffect, useRef, useState } from "react";
import { openRoyale, unlinkRoyale } from "./agent";
import { BackButton } from "./BackButton";
import { forgetRoyaleConsent } from "./RoyaleKey";
import { takeWarmRoyaleUrl } from "./royale-warm";
import { toast } from "./toast";

/**
 * GG Royale, full window, inside this app window: the hosted game fills the
 * whole window (under the title bar too), with Back and the title floating
 * over its top edge.
 *
 * The game is a REMOTE page, so it is boxed in:
 * - `sandbox` lets it run scripts and keep its own storage (its sign-in), but
 *   not navigate this app, open popups or submit to other pages;
 * - no capability lists a remote URL, so it can't call the app's commands;
 * - the app CSP's `frame-src` allows only the GG Royale origins.
 *
 * The way in is one move, using the game's own velvet curtain: nothing shows
 * while the game loads (the screen you came from stays put), then, once the
 * game says its curtain is painted shut (`painted`), the whole screen fades in
 * on the closed curtain, which the game opens. No loading screen. Back goes
 * straight home like every other screen. The message is a bare signal (no
 * data), accepted only from this frame's own window and origin. An older game
 * that never sends it is shown a moment after it loads; one that never loads
 * at all gets a plain "couldn't load" with Try again.
 *
 * `signed-out`: the game lost its sign-in. The app quietly fetches a fresh
 * one-time sign-in and reloads the game (once per RESIGN_MS), instead of
 * leaving "Open GG Royale from GG Coder to sign in" on screen inside GG Coder.
 *
 * `deleted`: the player deleted all their GG Royale data in the game. The app
 * forgets its link and the agreement (so nothing is reported and the link box
 * asks again before any new account), then goes home.
 */
type RoyaleSignal = "painted" | "deleted" | "signed-out";
/** At most one automatic re-sign-in this often (so a broken server can't loop). */
const RESIGN_MS = 30_000;
/** Shown anyway this long after the frame loads, if the game never says `painted`. */
const SHOW_FALLBACK_MS = 1200;
/** Give up waiting this long after opening, and say it didn't load. */
const SLOW_MS = 10_000;
export function RoyaleScreen({
  onClose,
  onShown,
}: {
  onClose: () => void;
  /** Called once the screen is showing (the game, or a "couldn't load"). */
  onShown?: () => void;
}): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastResign = useRef(0);
  const [shown, setShown] = useState(false);
  const [slow, setSlow] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  /** The game speaks the curtain protocol (it sent `painted`). */
  const talks = useRef(false);
  const timers = useRef<number[]>([]);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const later = (fn: () => void, ms: number): void => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  useEffect(() => {
    let alive = true;
    setError(null);
    setUrl(null);
    setShown(false);
    setSlow(false);
    talks.current = false;
    // A fresh one-time sign-in URL every time the screen opens: the one
    // fetched while pointing at the Royale button, if it's still fresh.
    const signIn = (attempt === 0 ? takeWarmRoyaleUrl() : null) ?? openRoyale();
    signIn
      .then((u) => alive && setUrl(u))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    const slowTimer = window.setTimeout(() => alive && setSlow(true), SLOW_MS);
    return () => {
      alive = false;
      window.clearTimeout(slowTimer);
    };
  }, [attempt]);

  useEffect(() => {
    if (!url) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.current?.contentWindow || e.origin !== origin) return;
      const data = e.data as { gg?: unknown; t?: unknown } | null;
      if (!data || data.gg !== "royale") return;
      const t = data.t as RoyaleSignal;
      if (t === "painted") {
        talks.current = true;
        setShown(true);
      } else if (t === "signed-out") {
        if (Date.now() - lastResign.current < RESIGN_MS) return;
        lastResign.current = Date.now();
        setAttempt((n) => n + 1);
      } else if (t === "deleted") {
        forgetRoyaleConsent();
        void unlinkRoyale()
          .catch(() => {})
          .finally(() => {
            toast("Your GG Royale data is deleted.", "success");
            onCloseRef.current();
          });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [url]);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  // Back goes straight home, the same way every other screen (GG Goals,
  // chats, settings) does: no curtain, no fade out.
  const leave = useCallback((): void => onClose(), [onClose]);

  // Nothing at all until the game is ready (or something went wrong).
  const failed = error ?? (slow && !shown ? "GG Royale didn't load. Check your connection." : null);
  // Once on screen, the screen stays up through a re-sign-in (only the game
  // frame itself fades out and back in on its own curtain).
  const [revealed, setRevealed] = useState(false);
  const visible = shown || failed !== null || revealed;
  useEffect(() => {
    if (shown) setRevealed(true);
  }, [shown]);
  const onShownRef = useRef(onShown);
  useEffect(() => {
    onShownRef.current = onShown;
  }, [onShown]);
  useEffect(() => {
    if (visible) onShownRef.current?.();
  }, [visible]);

  return (
    <div className={`picker royale-screen${visible ? " is-visible" : ""}`} aria-busy={!visible}>
      <div className="picker-head royale-head" data-tauri-drag-region>
        <BackButton label="Back" onClick={leave} />
        <span className="picker-title">GG Royale</span>
      </div>
      <div className="royale-stage">
        {url && (
          <iframe
            ref={frame}
            className={`royale-frame${shown ? " is-shown" : ""}`}
            // aria-label, not title: WebKit shows an iframe's title as a
            // tooltip whenever the pointer rests anywhere over the game.
            aria-label="GG Royale"
            src={url}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            allow="autoplay"
            onLoad={() => later(() => setShown(true), talks.current ? 0 : SHOW_FALLBACK_MS)}
          />
        )}
        {failed && (
          <div className="royale-status" role="alert">
            <span>{failed}</span>
            <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
