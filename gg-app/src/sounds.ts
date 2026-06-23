// UI sound effects. Each event maps to a short mp3 bundled by Vite (imported as
// a URL). Sounds are preloaded once and cloned per play so rapid repeats (and
// overlapping sounds) never cut each other off.
import clickUrl from "./assets/ui-click.mp3";
import warningUrl from "./assets/ui-warning.mp3";
import hoverUrl from "./assets/ui-hover.mp3";
import doneUrl from "./assets/ui-done.mp3";
import fuguUrl from "./assets/fugu.mp3";

export type UiSound = "click" | "warning" | "hover" | "done" | "fugu";

const SOURCES: Record<UiSound, string> = {
  click: clickUrl,
  warning: warningUrl,
  hover: hoverUrl,
  done: doneUrl,
  fugu: fuguUrl,
};

// Per-sound master volume — clicks are frequent so they sit quieter than the
// rarer, more deliberate cues.
const VOLUME: Record<UiSound, number> = {
  click: 0.25,
  warning: 0.5,
  hover: 0.45,
  done: 0.5,
  fugu: 0.6,
};

// Preloaded base elements (one per sound) cloned on each play.
const base: Partial<Record<UiSound, HTMLAudioElement>> = {};

function getBase(sound: UiSound): HTMLAudioElement {
  let el = base[sound];
  if (!el) {
    el = new Audio(SOURCES[sound]);
    el.preload = "auto";
    base[sound] = el;
  }
  return el;
}

const STORAGE_KEY = "gg-sound-enabled";

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

let enabled = loadEnabled();

/** Whether UI sounds are currently enabled. */
export function isSoundEnabled(): boolean {
  return enabled;
}

/** Toggle all UI sounds. Persisted per-machine in localStorage. */
export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Storage unavailable — keep the in-memory toggle only.
  }
}

/** Play a UI sound. Best-effort: autoplay rejections and decode errors are
 *  swallowed so audio never disrupts the UI. */
export function playSound(sound: UiSound): void {
  if (!enabled) return;
  try {
    const node = getBase(sound).cloneNode(true) as HTMLAudioElement;
    node.volume = VOLUME[sound];
    void node.play().catch(() => {});
  } catch {
    // Audio unavailable — ignore.
  }
}
