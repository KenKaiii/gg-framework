// The one gate for web addresses on Kleio's voice screen: what her `show`
// tool may ask the host to draw, and what "Open in browser" (or a link in a
// document she shows) may hand to the system browser. Both come from words a
// model chose or a file an agent wrote, so only plain web pages pass.

import { openUrl } from "../agent";

/** The longest web address Kleio shows or opens (the host's limit too). */
export const URL_MAX = 2_048;

/** A space or control character anywhere: the URL parser would quietly drop or encode it. */
function hasUnsafeChar(s: string): boolean {
  for (const c of s) {
    const n = c.codePointAt(0) ?? 0;
    if (n <= 0x20 || (n >= 0x7f && n <= 0x9f) || /\s/u.test(c)) return true;
  }
  return false;
}

/**
 * `raw` as a web address the browser may open, or null. Parsed by the URL
 * parser, then only `http:` or `https:` with a host, no user name or
 * password, and at most `URL_MAX` characters before and after parsing. So
 * `javascript:`, `data:`, `file:`, `blob:`, `mailto:`, `tel:`, `ftp:`, app
 * schemes, protocol-relative (`//host`) and malformed addresses are refused.
 */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > URL_MAX) return null;
  if (hasUnsafeChar(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.hostname === "") return null;
  return url.href.length <= URL_MAX ? url.href : null;
}

/**
 * Opens `raw` in the system browser if `safeExternalUrl` accepts it; anything
 * else is dropped. Returns whether it was handed over.
 */
export function openExternal(raw: unknown): boolean {
  const url = safeExternalUrl(raw);
  if (!url) return false;
  void openUrl(url).catch(() => console.warn("[voice] the browser didn't open"));
  return true;
}
