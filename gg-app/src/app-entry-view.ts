// kleio: "kleio" is Kleio's own screen (Blobs, Groups, Apps).
export type EntryView = "home" | "projects" | "goals" | "chats" | "motion" | "settings" | "kleio";

/** New windows always start at Home; workspace restore may replace this after boot. */
export function initialEntryView(_isSecondaryWindow: boolean): EntryView {
  return "home";
}

/** Set once Setup has been seen on this device (SetupPage marks it on mount). */
export const SETUP_SEEN_KEY = "kleio-setup-seen";

type SeenStorage = Pick<Storage, "getItem">;

/**
 * Whether this window should open Settings on Setup by itself: the main window
 * only, once per device. Storage that can't be read counts as seen, so a
 * broken store never reopens Setup on every launch.
 */
export function shouldOpenSetup(storage: SeenStorage | null, isSecondaryWindow: boolean): boolean {
  if (isSecondaryWindow || !storage) return false;
  try {
    return storage.getItem(SETUP_SEEN_KEY) !== "1";
  } catch {
    return false;
  }
}

/** Record that Setup was seen on this device. */
export function markSetupSeen(storage: Pick<Storage, "setItem"> | null): void {
  try {
    storage?.setItem(SETUP_SEEN_KEY, "1");
  } catch {
    // Private mode or a full store: Setup may open once more; harmless.
  }
}

/** `window.localStorage`, or null where reading it throws (or there is none). */
export function localStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
