const MAX_PROMPT_CACHE_KEY_LENGTH = 64;

export function normalizePromptCacheKey(key: string): string {
  if (key.length <= MAX_PROMPT_CACHE_KEY_LENGTH) return key;
  const hash = fnv1aHash(key);
  const prefixLength = MAX_PROMPT_CACHE_KEY_LENGTH - hash.length - 1;
  return `${key.slice(0, prefixLength)}:${hash}`;
}

function fnv1aHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
