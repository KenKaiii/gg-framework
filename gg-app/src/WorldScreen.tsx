import { useCallback, useEffect, useRef, useState } from "react";
import { BackButton } from "./BackButton";
import { useWorldSave, type WorldProfile } from "./world-save";
import { WorldCloudKey, WorldConsent } from "./WorldSaveUi";

/** What the game is told about the player (from the app's progress snapshot). */
export type WorldPlayer = {
  level: number;
  percent: number;
  xp: number;
  /** Where the XP came from; tells the game why a pop-up's XP was earned. */
  xpBySource?: { prompts: number; commits: number; streakBonus: number };
};

const XP_WHY: [keyof NonNullable<WorldPlayer["xpBySource"]>, string][] = [
  ["prompts", "prompt"],
  ["commits", "commit"],
  ["streakBonus", "streak bonus"],
];

/** Shown anyway this long after the frame loads, if the game never says `ready`. */
const SHOW_FALLBACK_MS = 1500;
/** Give up waiting this long after opening, and say it didn't load. */
const SLOW_MS = 10_000;

/**
 * World, full window, inside this app window: the local 3D game bundled with
 * the app (`public/world`, built by packages/gg-world) fills the whole window,
 * with Back and the title floating over its top edge. Same origin and local,
 * so no sandbox. Nothing leaves the machine unless the player turns on
 * the optional online save (world-save.ts).
 *
 * The screen fades in once the game posts `{ gg: 'world', t: 'ready' }`
 * (accepted only from this frame's window and this origin), or a moment after
 * the frame loads. On ready and whenever progress changes, the app posts
 * `{ gg: 'world', t: 'player', level, percent, xp }` to the frame, same
 * origin only. Unmounting (Back) drops the frame and frees its CPU/memory.
 */
export function WorldScreen({
  onClose,
  onShown,
  player,
}: {
  onClose: () => void;
  /** Called once the screen is showing (the game, or a "couldn't load"). */
  onShown?: () => void;
  /** Null until the app has read the player's progress. */
  player: WorldPlayer | null;
}): React.ReactElement {
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState(false);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const fallback = useRef<number | null>(null);

  useEffect(() => {
    setShown(false);
    setReady(false);
    setSlow(false);
    const slowTimer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      window.clearTimeout(slowTimer);
      if (fallback.current !== null) window.clearTimeout(fallback.current);
    };
  }, [attempt]);

  const post = useCallback((msg: Record<string, unknown>): void => {
    frame.current?.contentWindow?.postMessage({ gg: "world", ...msg }, window.location.origin);
  }, []);
  const save = useWorldSave({ ready, level: player?.level, post });
  const onGameSaveRef = useRef<(p: WorldProfile) => void>(save.onGameSave);
  useEffect(() => {
    onGameSaveRef.current = save.onGameSave;
  }, [save.onGameSave]);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      const data = e.data as { gg?: unknown; t?: unknown; profile?: unknown } | null;
      if (!data || data.gg !== "world") return;
      if (data.t === "ready") {
        setReady(true);
        setShown(true);
      } else if (data.t === "save" && typeof data.profile === "object" && data.profile !== null) {
        const p = data.profile as Record<string, unknown>;
        onGameSaveRef.current({
          name: typeof p.name === "string" ? p.name : null,
          look: p.look,
          owned: p.owned,
          spent: p.spent,
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Tell the game who's playing: on ready, and whenever progress changes.
  const level = player?.level;
  const percent = player?.percent;
  const xp = player?.xp;
  useEffect(() => {
    if (!ready || level === undefined || percent === undefined || xp === undefined) return;
    frame.current?.contentWindow?.postMessage(
      { gg: "world", t: "player", level, percent, xp },
      window.location.origin,
    );
  }, [ready, level, percent, xp]);

  // XP earned while World is open pops up in the game. The first snapshot
  // after opening is only the baseline.
  const lastXp = useRef<{ xp: number; by: WorldPlayer["xpBySource"] } | null>(null);
  const by = player?.xpBySource;
  useEffect(() => {
    if (xp === undefined) return;
    const last = lastXp.current;
    lastXp.current = { xp, by };
    if (!last || !ready || xp <= last.xp) return;
    const grew = XP_WHY.filter(([k]) => by && last.by && by[k] > last.by[k]);
    const why = grew.length === 1 ? grew[0]?.[1] : undefined;
    post(why ? { t: "xp", amount: xp - last.xp, why } : { t: "xp", amount: xp - last.xp });
  }, [ready, xp, by, post]);

  // Keys go to the game once it's on screen.
  useEffect(() => {
    if (shown) frame.current?.focus();
  }, [shown]);

  const failed = slow && !shown;
  const visible = shown || failed;
  const onShownRef = useRef(onShown);
  useEffect(() => {
    onShownRef.current = onShown;
  }, [onShown]);
  useEffect(() => {
    if (visible) onShownRef.current?.();
  }, [visible]);

  return (
    <div className={`picker world-screen${visible ? " is-visible" : ""}`} aria-busy={!visible}>
      <div className="picker-head world-head" data-tauri-drag-region>
        <BackButton label="Back" onClick={onClose} />
        <WorldCloudKey
          on={save.on}
          status={save.status}
          savedAt={save.savedAt}
          onTurnOn={save.turnOn}
          onTurnOff={save.turnOff}
          onDelete={save.deleteSave}
        />
      </div>
      <div className="world-stage">
        {!failed && (
          <iframe
            key={attempt}
            ref={frame}
            className={`world-frame${shown ? " is-shown" : ""}`}
            // aria-label, not title: WebKit shows an iframe's title as a tooltip.
            aria-label="World"
            src="world/index.html"
            allow="autoplay; fullscreen"
            onLoad={() => {
              if (fallback.current !== null) window.clearTimeout(fallback.current);
              // An older game that never says `ready`: show it anyway, and still send the player (so it isn't stuck
              // at level 1).
              fallback.current = window.setTimeout(() => {
                setShown(true);
                setReady(true);
              }, SHOW_FALLBACK_MS);
            }}
          />
        )}
        {save.asking && <WorldConsent onAnswer={save.agree} onClose={save.closeAsk} />}
        {failed && (
          <div className="world-status" role="alert">
            <span>World couldn't load.</span>
            <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
