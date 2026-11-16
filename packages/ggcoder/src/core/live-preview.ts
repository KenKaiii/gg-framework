// Live preview: messages sent from the chat overlay on the user's running web
// app. The agent sees the picked element and a short-reply rule in one tagged
// block after the user's words; transcripts strip that block and show the
// element as a chip, so the user only ever sees what they typed.

export interface LivePreviewElement {
  selector: string;
  html: string;
  tag: string;
  text: string;
}

export interface LivePreviewMeta {
  url: string;
  element: LivePreviewElement | null;
}

const LIMITS = { url: 2000, selector: 400, html: 4000, tag: 40, text: 120 } as const;
const OPEN = "<live-preview";
const CLOSE = "</live-preview>";

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" ? v.slice(0, max) : null;

/** Validate the `meta.livePreview` field of a `/prompt` body; null when absent or malformed. */
export function parseLivePreviewMeta(raw: unknown): LivePreviewMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const url = str(r.url, LIMITS.url);
  if (url === null) return null;
  let element: LivePreviewElement | null = null;
  if (typeof r.element === "object" && r.element !== null) {
    const e = r.element as Record<string, unknown>;
    const selector = str(e.selector, LIMITS.selector);
    const html = str(e.html, LIMITS.html);
    const tag = str(e.tag, LIMITS.tag);
    const text = str(e.text, LIMITS.text);
    if (selector !== null && html !== null && tag !== null && text !== null) {
      element = {
        selector,
        html,
        tag: tag.replace(/[^a-z0-9-]/gi, ""),
        text: text.replace(/\s+/g, " ").trim(),
      };
    }
  }
  return { url, element };
}

/** The chip label for a picked element, e.g. `<h2> Iced latte`. */
export function livePreviewChip(element: Pick<LivePreviewElement, "tag" | "text">): string {
  return `<${element.tag}> ${element.text}`.trim();
}

const attr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, " ");
const unattr = (s: string): string => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** What the agent receives for a live-preview message. */
export function buildLivePreviewPrompt(text: string, meta: LivePreviewMeta, cwd: string): string {
  const chip = meta.element ? ` element="${attr(livePreviewChip(meta.element))}"` : "";
  const lines = [`${OPEN} url="${attr(meta.url)}"${chip}>`];
  lines.push(
    `Sent from the live preview chat on the running app at ${meta.url} (project: ${cwd}).`,
  );
  if (meta.element) {
    // Fence longer than any backtick run in the page's HTML, so it can't close early.
    const fence = "`".repeat(
      Math.max(3, ...[...meta.element.html.matchAll(/`+/g)].map((m) => m[0].length + 1)),
    );
    lines.push(
      `The user right-clicked this element (CSS path: ${meta.element.selector}):`,
      `${fence}html`,
      meta.element.html,
      fence,
    );
  }
  lines.push(
    "The reply shows in a small bubble on the page. Reply in one short sentence saying what you did, " +
      `e.g. "Done, the text now says 'logo'." No lists, headings, file paths or extra notes unless asked. ` +
      "If this is a question, answer it in two or three sentences at most. These rules apply to this message only.",
    CLOSE,
  );
  return `${text}\n\n${lines.join("\n")}`;
}

/**
 * Undo {@link buildLivePreviewPrompt} for display: the user's own words and the
 * element chip. Null when the text isn't a live-preview message.
 */
export function splitLivePreviewPrompt(text: string): { text: string; chip: string | null } | null {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(CLOSE)) return null;
  const start = trimmed.lastIndexOf(`\n\n${OPEN} `);
  const head = start === -1 ? (trimmed.startsWith(`${OPEN} `) ? 0 : -1) : start;
  if (head === -1) return null;
  const openTag = /^\s*<live-preview url="[^"]*"(?: element="([^"]*)")?>/.exec(trimmed.slice(head));
  if (!openTag) return null;
  return {
    text: trimmed.slice(0, head).trim(),
    chip: openTag[1] !== undefined ? unattr(openTag[1]) : null,
  };
}
