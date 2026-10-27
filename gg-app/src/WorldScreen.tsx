import { useCallback, useEffect, useRef, useState } from "react";
import { BackButton } from "./BackButton";
import { useWorldRadio } from "./world-radio";
import { useWorldLive } from "./world-live";
import { useWorldSave, type WorldProfile } from "./world-save";
import { WorldCloudKey, WorldConsent, WorldLiveConsent, type CloudAnchor } from "./WorldSaveUi";
import { readWorldStore, writeWorldStore } from "./world-store";
import { WorldTv, useWorldTv } from "./WorldTv";
import { WorldLoading, type WorldBoot } from "./WorldLoading";

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
/** Only for a game that never says `ready` (the bundled one always does, once it has drawn): long enough that a
 * normal load always wins, so World never fades in on a black frame. */
const SHOW_FALLBACK_MS = 8000;
/** Give up waiting this long after opening, and say it didn't load. */
const SLOW_MS = 10_000;
/** The origin a sealed (sandboxed, no same-origin) frame's messages carry. */
const WORLD_ORIGIN = "null";

/**
 * World, full window, inside this app window: the local 3D game bundled with
 * the app (`public/world`, built by packages/gg-world) fills the whole window,
 * with Back and the title floating over its top edge. Nothing leaves the
 * machine unless the player turns on the optional online save (world-save.ts).
 *
 * SEALED: the frame is `sandbox="allow-scripts"` with no same-origin, so the
 * game can't reach this page, the app's commands (Tauri's IPC needs a key only
 * the main frame has) or the app's storage. Whatever ever ends up inside World
 * (other players' chat, one day) can't drive the app or a coding session. The
 * game can only ASK, by message: its saves (world-store.ts keeps only World's
 * own keys), the radio, the TV video, the online save. Its messages come from
 * an opaque origin ("null") and are accepted only from this frame's window.
 *
 * The screen fades in once the game posts `{ gg: 'world', t: 'ready' }`, or a
 * moment after the frame loads. On ready and whenever progress changes, the
 * app posts `{ gg: 'world', t: 'player', level, percent, xp }` to the frame.
 * Unmounting (Back) drops the frame and frees its CPU/memory.
 */
export function WorldScreen({
  onClose,
  onShown,
  player,
  computer = false,
  onComputer,
}: {
  onClose: () => void;
  /** Called once the screen is showing (the game, or a "couldn't load"). */
  onShown?: () => void;
  /** Null until the app has read the player's progress. */
  player: WorldPlayer | null;
  /** The in-game computer is open: this window's own GG Coder is framed as a monitor over World (App.tsx). */
  computer?: boolean;
  /** The game sat the player at a computer (true) or stood them up (false). */
  onComputer?: (open: boolean) => void;
}): React.ReactElement {
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState(false);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  // the online-save menu's anchor (the game's cloud button), null = closed
  const [cloudAt, setCloudAt] = useState<CloudAnchor | null>(null);
  const closeCloud = useCallback((): void => setCloudAt(null), []);
  // the loading screen: World's own progress, and whether it's still on screen (it fades out once World is drawn)
  const [boot, setBoot] = useState<WorldBoot | null>(null);
  const [loaderOn, setLoaderOn] = useState(true);
  const frame = useRef<HTMLIFrameElement>(null);
  const fallback = useRef<number | null>(null);

  useEffect(() => {
    setShown(false);
    setReady(false);
    setSlow(false);
    setBoot(null);
    setLoaderOn(true);
    const slowTimer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      window.clearTimeout(slowTimer);
      if (fallback.current !== null) window.clearTimeout(fallback.current);
    };
  }, [attempt]);

  // A sealed frame's origin is opaque, so messages can't name it: they go to this frame's window only.
  const post = useCallback((msg: Record<string, unknown>): void => {
    frame.current?.contentWindow?.postMessage({ gg: "world", ...msg }, "*");
  }, []);
  const tv = useWorldTv(post, () => frame.current?.focus());
  const { state: tvState, frame: tvFrame } = tv;
  const save = useWorldSave({ ready, shown, level: player?.level, post });
  // keep the game's cloud button in step: filled when online save is on, a dot when it can't reach the server
  useEffect(() => {
    if (ready) post({ t: "cloud", on: save.on, status: save.status });
  }, [ready, save.on, save.status, post]);
  const radio = useWorldRadio(post);
  // World is paused while the app is switched away (hidden); the live world closes after a minute of that.
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onVis = (): void => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  // Only with online save on and its row on the server (MULTIPLAYER.md: consent gates the live world).
  const live = useWorldLive({ enabled: save.live, paused: hidden, post });
  const onLiveRef = useRef(live.onGameMessage);
  useEffect(() => {
    onLiveRef.current = live.onGameMessage;
  }, [live.onGameMessage]);
  const onGameSaveRef = useRef<(p: WorldProfile) => void>(save.onGameSave);
  const onComputerRef = useRef(onComputer);
  useEffect(() => {
    onComputerRef.current = onComputer;
  }, [onComputer]);
  // Closed from the app (Stand up, Back): stand the player up in the game. Keys go to GG Coder while it's open.
  const wasComputer = useRef(false);
  useEffect(() => {
    if (computer) frame.current?.blur();
    else if (wasComputer.current) {
      post({ t: "computer", open: false });
      frame.current?.focus();
    }
    wasComputer.current = computer;
  }, [computer, post]);
  useEffect(() => {
    onGameSaveRef.current = save.onGameSave;
  }, [save.onGameSave]);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.current?.contentWindow || e.origin !== WORLD_ORIGIN) return;
      const data = e.data as {
        gg?: unknown;
        t?: unknown;
        profile?: unknown;
        station?: unknown;
        volume?: unknown;
        set?: unknown;
        open?: unknown;
        m?: unknown;
      } | null;
      if (!data || data.gg !== "world") return;
      if (radio.onGameMessage(data)) return;
      if (tv.onGameMessage(data)) return;
      if (onLiveRef.current(data)) return;
      if (data.t === "computer") {
        // The game only ASKS: the app opens its own GG Coder (never the game's), for this window's own projects.
        onComputerRef.current?.(data.open === true);
      } else if (data.t === "cloud-menu") {
        // the game's cloud button (bottom-right icon bar): open the online-save menu just above it (toggle)
        const r = (data as { rect?: unknown }).rect as Record<string, unknown> | undefined;
        const n = (v: unknown, hi: number): number =>
          typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(hi, v)) : 0;
        const W = window.innerWidth;
        const H = window.innerHeight;
        setCloudAt((cur) =>
          cur ? null : { x: n(r?.x, W), y: n(r?.y, H), w: n(r?.w, 80), h: n(r?.h, 80) },
        );
      } else if (data.t === "progress") {
        const d = data as { p?: unknown; label?: unknown };
        const p =
          typeof d.p === "number" && Number.isFinite(d.p) ? Math.max(0, Math.min(1, d.p)) : 0;
        const label =
          typeof d.label === "string"
            ? d.label.replace(/[^\p{L}\p{N} '.,-]/gu, "").slice(0, 48)
            : "";
        // never goes backwards (a late message from an earlier step)
        setBoot((b) => (b && b.p > p ? b : { p, label: label || (b?.label ?? "") }));
      } else if (data.t === "boot") {
        post({ t: "storage", data: readWorldStore() });
      } else if (data.t === "store") {
        writeWorldStore(data.set);
      } else if (data.t === "ready") {
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
  }, [radio, tv, post]);

  // Tell the game who's playing: on ready, and whenever progress changes.
  const level = player?.level;
  const percent = player?.percent;
  const xp = player?.xp;
  useEffect(() => {
    if (!ready || level === undefined || percent === undefined || xp === undefined) return;
    post({ t: "player", level, percent, xp });
  }, [ready, level, percent, xp, post]);

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

  // Keys that land on the app instead of the game (focus on Back / the cloud key, or the app window itself, which is
  // where WebKit leaves it after clicking app buttons): Escape still closes what's open in the game, and every other
  // key moves focus back into the game so the next press works. The consent box keeps its own keys.
  const asking = save.asking || save.askingLive;
  useEffect(() => {
    if (!shown || computer) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || asking) return;
      // (the target can be the window or the document itself, which have no closest())
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("input, textarea, [contenteditable='true'], [role='dialog']")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        post({ t: "key", key: "Escape" });
      }
      frame.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, asking, post, computer]);

  const failed = slow && !shown;
  const visible = shown || failed;
  const onShownRef = useRef(onShown);
  useEffect(() => {
    onShownRef.current = onShown;
  }, [onShown]);
  useEffect(() => {
    if (visible) onShownRef.current?.();
  }, [visible]);
  // the loading screen fades out over the drawn world, then is removed (its loops stop)
  useEffect(() => {
    if (!visible) return;
    const t = window.setTimeout(() => setLoaderOn(false), 600);
    return () => window.clearTimeout(t);
  }, [visible]);

  return (
    // On screen from the click (the loading screen), so opening World never looks frozen; is-visible = World is drawn.
    <div
      className={`picker world-screen is-open${visible ? " is-visible" : ""}`}
      aria-busy={!visible}
    >
      <div className="picker-head world-head" data-tauri-drag-region>
        <BackButton label="Back" onClick={onClose} />
      </div>
      {/* the online-save menu, opened from the cloud button in the game's bottom-right icon bar */}
      <WorldCloudKey
        anchor={cloudAt}
        onDismiss={closeCloud}
        on={save.on}
        status={save.status}
        savedAt={save.savedAt}
        onTurnOn={save.turnOn}
        onTurnOff={save.turnOff}
        onDelete={save.deleteSave}
        onDeleteAccount={save.deleteAccount}
        onRetry={save.retryNow}
      />
      <div className="world-stage">
        {!failed && (
          <iframe
            key={attempt}
            ref={frame}
            className={`world-frame${shown ? " is-shown" : ""}`}
            // aria-label, not title: WebKit shows an iframe's title as a tooltip.
            aria-label="World"
            src="world/index.html"
            sandbox="allow-scripts"
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
        {loaderOn && !failed && <WorldLoading boot={boot} gone={visible} />}
        <WorldTv state={tvState} frameRef={tvFrame} />
        {computer && (
          // This window's GG Coder sits over World (the app itself: .app-in-monitor); Stand up leaves it.
          <div className="world-monitor">
            <button
              type="button"
              className="btn btn-sm world-monitor-leave"
              onClick={() => onComputer?.(false)}
            >
              Stand up
            </button>
          </div>
        )}
        {/* held while the computer is open: it would sit over the monitor and block Stand up */}
        {save.asking && !computer && <WorldConsent onAnswer={save.agree} onClose={save.closeAsk} />}
        {!save.asking && save.askingLive && !computer && (
          <WorldLiveConsent onAnswer={save.answerLive} onClose={save.closeAskLive} />
        )}
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
