import type { Options as TurndownOptions } from "turndown";

/**
 * Minimum article length (in characters, per Readability's `length` field)
 * required before we trust the extraction. Below this we fall back to the
 * regex-based `htmlToCleanText` so short/empty pages don't degrade output.
 */
const CHAR_THRESHOLD = 250;

/** Raised when one of the optional extraction dependencies is not installed. */
export class ExtractorUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractorUnavailable";
  }
}

interface LinkedomModule {
  parseHTML(html: string): { document: Document };
}

interface ReadabilityArticle {
  title?: string | null;
  content?: string | null;
  textContent?: string | null;
  length?: number | null;
}

interface ReadabilityModule {
  Readability: new (
    doc: Document,
    options?: { charThreshold?: number },
  ) => { parse(): ReadabilityArticle | null };
}

interface TurndownInstance {
  turndown(html: string): string;
  use(plugin: unknown): TurndownInstance;
  addRule(key: string, rule: unknown): TurndownInstance;
  remove(filter: string | string[]): TurndownInstance;
}

interface TurndownModule {
  default: new (options?: TurndownOptions) => TurndownInstance;
}

interface GfmModule {
  gfm: unknown;
}

interface ExtractorModules {
  parseHTML: LinkedomModule["parseHTML"];
  Readability: ReadabilityModule["Readability"];
  TurndownService: TurndownModule["default"];
  gfm: unknown;
}

let cached: ExtractorModules | null = null;

/**
 * Lazily resolve the HTML→Markdown extraction stack (linkedom, Readability,
 * Turndown + GFM plugin). Mirrors `loadChromium()` in browser-session.ts: dynamic
 * imports behind a non-literal specifier so `tsc` does not statically require
 * the optional dependencies, with results cached. Throws `ExtractorUnavailable`
 * if any are missing so callers can degrade to the regex path.
 */
export async function loadExtractor(): Promise<ExtractorModules> {
  if (cached) return cached;

  const linkedomName: string = "linkedom";
  const readabilityName: string = "@mozilla/readability";
  const turndownName: string = "turndown";
  const gfmName: string = "turndown-plugin-gfm";

  try {
    const [linkedom, readability, turndown, gfmMod] = (await Promise.all([
      import(linkedomName),
      import(readabilityName),
      import(turndownName),
      import(gfmName),
    ])) as [LinkedomModule, ReadabilityModule, TurndownModule, GfmModule];

    if (!linkedom.parseHTML || !readability.Readability || !turndown.default || !gfmMod.gfm) {
      throw new ExtractorUnavailable("extraction modules loaded but expected exports are missing");
    }

    cached = {
      parseHTML: linkedom.parseHTML,
      Readability: readability.Readability,
      TurndownService: turndown.default,
      gfm: gfmMod.gfm,
    };
    return cached;
  } catch (err) {
    if (err instanceof ExtractorUnavailable) throw err;
    throw new ExtractorUnavailable(
      err instanceof Error ? err.message : "failed to load extraction modules",
    );
  }
}

function buildTurndown(mods: ExtractorModules): TurndownInstance {
  const service = new mods.TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  service.use(mods.gfm);
  // Preserve fenced code blocks: keep <pre>/<code> structure intact rather
  // than collapsing whitespace inside them.
  service.addRule("fencedPre", {
    filter: ["pre"],
    replacement(_content: string, node: { textContent?: string | null }): string {
      const code = (node.textContent ?? "").replace(/\n$/, "");
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    },
  });
  // Drop anchors without an href (navigation/JS noise) — keep their text only.
  service.addRule("bareAnchor", {
    filter(node: { nodeName: string; getAttribute(name: string): string | null }): boolean {
      return node.nodeName === "A" && !node.getAttribute("href");
    },
    replacement(content: string): string {
      return content;
    },
  });
  return service;
}

/**
 * Run Readability over the page HTML and convert the extracted main content to
 * clean Markdown (headings, lists, GFM tables, fenced code preserved). Returns
 * `null` when extraction fails or the article is too short, so the caller can
 * fall back to `htmlToCleanText`.
 */
export async function extractToMarkdown(
  html: string,
  url: string,
): Promise<{ markdown: string; title?: string } | null> {
  const mods = await loadExtractor();

  let document: Document;
  try {
    document = mods.parseHTML(html).document;
  } catch {
    return null;
  }

  // Readability reads <base>/document URL for resolving links; set a baseURI
  // hint via a <base> tag when none is present so relative links resolve.
  try {
    if (!document.querySelector("base")) {
      const base = document.createElement("base");
      base.setAttribute("href", url);
      document.head?.appendChild(base);
    }
  } catch {
    // best-effort; ignore if the DOM shim disallows it
  }

  let article: ReadabilityArticle | null;
  try {
    article = new mods.Readability(document, { charThreshold: CHAR_THRESHOLD }).parse();
  } catch {
    return null;
  }

  if (!article || !article.content) return null;
  if ((article.length ?? 0) < CHAR_THRESHOLD) return null;

  let markdown: string;
  try {
    markdown = buildTurndown(mods).turndown(article.content);
  } catch {
    return null;
  }

  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();
  if (!markdown) return null;

  return { markdown, title: article.title ?? undefined };
}
