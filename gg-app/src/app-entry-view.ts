export type EntryView = "home" | "projects" | "goals" | "chats" | "motion" | "royale" | "settings";

/** New windows always start at Home; workspace restore may replace this after boot. */
export function initialEntryView(_isSecondaryWindow: boolean): EntryView {
  return "home";
}
