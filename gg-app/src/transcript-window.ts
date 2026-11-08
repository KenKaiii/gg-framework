/**
 * Which slice of a long conversation the transcript keeps mounted.
 *
 * Every mounted row costs memory and layout (markdown, code blocks, images),
 * so the transcript renders only your last {@link TURN_PAGE} turns and loads
 * earlier ones a page at a time as you scroll toward the top. A "turn" starts
 * at one of your messages and runs up to the next, so a page never cuts a
 * reply in half.
 *
 * Pure functions over the item list so the rules are testable without layout
 * (`transcript-window.test.ts`); App owns the scroll handling.
 */

/** Turns shown on open, and added by each load of older history. */
export const TURN_PAGE = 20;

/** The item fields the window rules read. */
export interface WindowItem {
  readonly id: number;
  readonly kind: string;
}

/**
 * Index of the first item in the window holding the last `turns` turns
 * counted back from `end` (exclusive). 0 when there are no more turns than
 * that, so a short chat renders whole.
 */
export function turnStartIndex(
  items: readonly WindowItem[],
  turns: number,
  end: number = items.length,
): number {
  let seen = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (items[i]?.kind !== "user") continue;
    seen += 1;
    if (seen === turns) {
      // Anything before the oldest turn in range belongs to an older turn.
      return i;
    }
  }
  return 0;
}

/**
 * Where the mounted slice starts. `startId` null means "follow the newest
 * {@link TURN_PAGE} turns"; otherwise the slice starts at that item, so rows
 * the reader is looking at never shift when new turns arrive below. An id that
 * is no longer in the list (a new session hydrated) falls back to the default.
 */
export function windowStartIndex(items: readonly WindowItem[], startId: number | null): number {
  const latest = turnStartIndex(items, TURN_PAGE);
  if (startId === null) return latest;
  const index = items.findIndex((item) => item.id === startId);
  return index < 0 ? latest : Math.min(index, latest);
}

/** Id of the item that starts the window one page of turns earlier. */
export function earlierStartId(items: readonly WindowItem[], start: number): number | null {
  if (start <= 0) return null;
  return items[turnStartIndex(items, TURN_PAGE, start)]?.id ?? null;
}
