import type { Item } from "./transcript-item";

/** How much of the first prompt a chat's title shows. */
export const CHAT_TITLE_LIMIT = 10;

/** A chat's title: its first prompt cut to {@link CHAT_TITLE_LIMIT} characters. */
export function chatTitle(prompt: string | null | undefined): string {
  const text = prompt?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) return "New chat";
  // Code points, so an emoji is never cut in half.
  const chars = Array.from(text);
  if (chars.length <= CHAT_TITLE_LIMIT) return text;
  return `${chars.slice(0, CHAT_TITLE_LIMIT).join("").trimEnd()}\u2026`;
}

/** The first prompt the user typed themselves (not an @Ken question). */
export function firstUserPrompt(items: readonly Item[]): string | null {
  for (const item of items) {
    if (item.kind === "user" && !item.ken && !item.kenSent && item.text.trim()) return item.text;
  }
  return null;
}
