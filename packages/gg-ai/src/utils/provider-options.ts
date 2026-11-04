import type { ProviderOptions } from "../types.js";

/**
 * Body fields `providerOptions` may never supply, even when gg-ai left them
 * unset: they define what the request *is* (or how gg-ai parses the reply), so
 * each has a dedicated, validated option instead.
 */
const RESERVED_BODY_FIELDS: ReadonlySet<string> = new Set([
  "contents",
  "dimensions",
  "documents",
  "encoding_format",
  "input",
  "messages",
  "model",
  "query",
  "requests",
  "stream",
  "system",
  "tools",
  "top_n",
  // Never copy prototype-shaped keys onto a request body.
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Merge caller-supplied provider-specific fields into a request body without
 * letting them override anything gg-ai set: a field already present on `body`
 * (with a defined value) wins, and reserved core fields are always skipped.
 * Returns a new object; neither input is mutated. Keys are applied in sorted
 * order so the resulting body is deterministic.
 */
export function mergeProviderOptions<T extends object>(
  body: T,
  providerOptions: ProviderOptions | undefined,
): T {
  if (!providerOptions) return body;
  const base = body as Readonly<Record<string, unknown>>;
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(providerOptions).sort()) {
    if (RESERVED_BODY_FIELDS.has(key)) continue;
    if (Object.hasOwn(base, key) && base[key] !== undefined) continue;
    const value = providerOptions[key];
    if (value === undefined) continue;
    Object.defineProperty(extra, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (Object.keys(extra).length === 0) return body;
  return { ...base, ...extra } as T;
}
