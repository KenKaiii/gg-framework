/**
 * Anthropic's minimum cacheable prompt length per model family. A
 * `cache_control` breakpoint on a shorter prefix is silently ignored, so a
 * prewarm below it writes nothing and only costs a request.
 * Source: Anthropic prompt-caching docs ("Cache limitations").
 */
const ANTHROPIC_MIN_CACHEABLE_TOKENS: readonly (readonly [RegExp, number])[] = [
  [/haiku-4-5|opus-4-[56]/, 4096],
  [/haiku-3-5|haiku-3\b/, 2048],
  [/[a-z]-(?:[5-9]|\d{2})(?:-|$)/, 512], // 5.x and later families (family name, then major)
  [/sonnet-4|opus-4|sonnet-3-7/, 1024],
];

/** Minimum cacheable tokens for an Anthropic model (1024 when unknown). */
export function anthropicMinCacheableTokens(model: string): number {
  for (const [pattern, min] of ANTHROPIC_MIN_CACHEABLE_TOKENS) {
    if (pattern.test(model)) return min;
  }
  return 1024;
}

/** Rough token estimate (~3.5 chars/token) of a serialized request prefix. */
export function estimatePrefixTokens(...parts: unknown[]): number {
  let chars = 0;
  for (const part of parts) if (part !== undefined) chars += JSON.stringify(part).length;
  return Math.ceil(chars / 3.5);
}
