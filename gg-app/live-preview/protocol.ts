// Messages between the page script (runs in the previewed app, untrusted) and
// the chat frame (cross-origin iframe, the only route to the agent). The page
// only ever sends element data and layout; the frame only sends UI requests.
// Each side checks the sender's window and origin before reading a message.

export interface PickedElement {
  selector: string;
  tag: string;
  text: string;
  html: string;
}

export type PageToFrame =
  | { type: "gg-live:hello"; url: string; viewport: Viewport }
  | { type: "gg-live:viewport"; viewport: Viewport }
  | { type: "gg-live:url"; url: string }
  | { type: "gg-live:picked"; element: PickedElement | null; missing: boolean }
  | { type: "gg-live:picking"; on: boolean }
  | { type: "gg-live:focus" };

export type FrameToPage =
  | { type: "gg-live:ready" }
  | { type: "gg-live:size"; width: number; height: number }
  | { type: "gg-live:picking"; on: boolean }
  | { type: "gg-live:clear-pick" }
  | { type: "gg-live:open"; open: boolean };

export interface Viewport {
  width: number;
  height: number;
}

const LIMITS = { url: 2000, selector: 400, tag: 40, text: 120, html: 4000 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown, max: number): string | null =>
  typeof v === "string" ? v.slice(0, max) : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 100_000 ? v : null;

function viewport(v: unknown): Viewport | null {
  if (!isObj(v)) return null;
  const width = num(v.width);
  const height = num(v.height);
  return width === null || height === null ? null : { width, height };
}

function element(v: unknown): PickedElement | null {
  if (!isObj(v)) return null;
  const selector = str(v.selector, LIMITS.selector);
  const tag = str(v.tag, LIMITS.tag);
  const text = str(v.text, LIMITS.text);
  const html = str(v.html, LIMITS.html);
  if (selector === null || tag === null || text === null || html === null) return null;
  return { selector, tag: tag.replace(/[^a-z0-9-]/gi, ""), text, html };
}

/** A message from the page, validated field by field; null for anything else. */
export function parsePageMessage(data: unknown): PageToFrame | null {
  if (!isObj(data) || typeof data.type !== "string") return null;
  switch (data.type) {
    case "gg-live:hello": {
      const url = str(data.url, LIMITS.url);
      const vp = viewport(data.viewport);
      return url !== null && vp ? { type: data.type, url, viewport: vp } : null;
    }
    case "gg-live:viewport": {
      const vp = viewport(data.viewport);
      return vp ? { type: data.type, viewport: vp } : null;
    }
    case "gg-live:url": {
      const url = str(data.url, LIMITS.url);
      return url !== null ? { type: data.type, url } : null;
    }
    case "gg-live:picked":
      return data.element === null || element(data.element)
        ? { type: data.type, element: element(data.element), missing: data.missing === true }
        : null;
    case "gg-live:picking":
      return { type: data.type, on: data.on === true };
    case "gg-live:focus":
      return { type: data.type };
    default:
      return null;
  }
}

/** A message from the frame, validated; null for anything else. */
export function parseFrameMessage(data: unknown): FrameToPage | null {
  if (!isObj(data) || typeof data.type !== "string") return null;
  switch (data.type) {
    case "gg-live:ready":
    case "gg-live:clear-pick":
      return { type: data.type };
    case "gg-live:size": {
      const width = num(data.width);
      const height = num(data.height);
      return width === null || height === null ? null : { type: data.type, width, height };
    }
    case "gg-live:picking":
      return { type: data.type, on: data.on === true };
    case "gg-live:open":
      return { type: data.type, open: data.open === true };
    default:
      return null;
  }
}

/**
 * The page's address as the dev server's: the agent edits the real app, so
 * it's told the dev URL, not the proxy's.
 */
export function toDevUrl(pageUrl: string, devUrl: string, proxyOrigins: readonly string[]): string {
  try {
    const u = new URL(pageUrl);
    if (!proxyOrigins.includes(u.origin)) return pageUrl;
    return new URL(u.pathname + u.search + u.hash, devUrl).href;
  } catch {
    return pageUrl;
  }
}

export const chipName = (el: Pick<PickedElement, "tag" | "text">): string =>
  `<${el.tag}> ${el.text}`.trim();
