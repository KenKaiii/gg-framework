// Skills the sidecar's safety scan refused to load, shown once as a warning
// toast. Never a prompt: a blocked skill is simply not loaded.
import type { BlockedSkill } from "./agent";

const STORAGE_KEY = "gg-blocked-skills-shown";
/** Keeps the remembered list small; the oldest entries fall off first. */
const MAX_REMEMBERED = 200;

/** Minimal Storage surface, so tests can pass an in-memory one. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** One plain line: what was blocked and why. */
export function blockedSkillMessage(skill: BlockedSkill): string {
  return `Skill "${skill.name}" blocked for safety: ${skill.reason}`;
}

function shownKey(skill: BlockedSkill): string {
  // The same skill at the same content is shown once; a changed version is new.
  return `${skill.scope}\0${skill.path}\0${skill.hash || skill.reason}`;
}

function readShown(store: KeyValueStore): string[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The messages for blocked skills not shown before (across windows and app
 * restarts), recording them as shown.
 */
export function takeNewBlockedSkillMessages(
  blocked: readonly BlockedSkill[] | undefined,
  store: KeyValueStore,
): string[] {
  if (!blocked || blocked.length === 0) return [];
  const shown = readShown(store);
  const seen = new Set(shown);
  const messages: string[] = [];
  for (const skill of blocked) {
    const key = shownKey(skill);
    if (seen.has(key)) continue;
    seen.add(key);
    shown.push(key);
    messages.push(blockedSkillMessage(skill));
  }
  if (messages.length > 0) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(shown.slice(-MAX_REMEMBERED)));
    } catch {
      // Storage full/unavailable: worst case the notice shows again next start.
    }
  }
  return messages;
}
