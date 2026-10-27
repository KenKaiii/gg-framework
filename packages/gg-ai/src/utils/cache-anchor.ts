import type { Message } from "../types.js";

/**
 * Wire-safe form of the host's cache-anchor hint (`Message.cacheAnchor`): the
 * conversation up to and including this message will not change again during
 * the current run, so the Anthropic encoder may pin its long-lived cache
 * breakpoint here instead of at the turn's opening message.
 *
 * `stream()` sets it at the provider boundary, where the metadata field itself
 * is removed. A symbol key survives the object spreads of the wire passes but
 * never reaches JSON, so no provider sends it.
 */
const CACHE_ANCHOR = Symbol("gg.cacheAnchor");

type Marked = { [CACHE_ANCHOR]?: true };

/** Return a copy of `message` marked as a cache anchor. */
export function markCacheAnchor<T extends Message>(message: T): T {
  const marked: T & Marked = { ...message };
  marked[CACHE_ANCHOR] = true;
  return marked;
}

/** True for a message marked as a cache anchor (see above). */
export function isCacheAnchor(message: Message): boolean {
  return (message as Message & Marked)[CACHE_ANCHOR] === true;
}
