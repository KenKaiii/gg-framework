import type { ShellSuggestion } from "./agent";

/** Rows the `!` picker shows at most. */
export const SHELL_MENU_MAX = 8;

/**
 * Suggestions matching what follows the `!`, keeping their order (most used
 * first). Commands that start with the query come before ones that only
 * contain it, so `!git` lists git commands ahead of `pnpm lint:git`.
 */
export function filterShellSuggestions(
  suggestions: readonly ShellSuggestion[],
  query: string,
): ShellSuggestion[] {
  const q = query.trimStart().toLowerCase();
  if (!q) return suggestions.slice(0, SHELL_MENU_MAX);
  const starts: ShellSuggestion[] = [];
  const contains: ShellSuggestion[] = [];
  for (const s of suggestions) {
    const c = s.command.toLowerCase();
    if (c === q) continue;
    if (c.startsWith(q)) starts.push(s);
    else if (c.includes(q)) contains.push(s);
  }
  return [...starts, ...contains].slice(0, SHELL_MENU_MAX);
}

/** The quiet label beside a suggestion: how often it ran, or why it's offered. */
export function shellSuggestionNote(s: ShellSuggestion): string {
  if (s.count === 1) return "ran once";
  if (s.count > 1) return `ran ${s.count} times`;
  return s.source ? `from ${s.source}` : "";
}

/**
 * Whether Enter fills the highlighted command instead of running the typed
 * one: only for a bare `!`, or once the user chose a row with ↑/↓ since their
 * last edit. Otherwise `!ls` would turn into a suggested `ls -la` on Enter.
 */
export function shellEnterPicks(input: string, navigatedFor: string | null): boolean {
  return !input.slice(1).trim() || navigatedFor === input;
}
