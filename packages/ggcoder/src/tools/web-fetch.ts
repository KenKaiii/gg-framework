import { z } from "zod";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import { sliceHead } from "@kenkaiiii/gg-ai";
import { extractToMarkdown } from "./html-extract.js";
import { extractPdfText, PdfExtractorUnavailable } from "./pdf-extract.js";
import { checkUrlPolicy, withNetworkPolicy, type GetNetworkPolicy } from "../core/network-guard.js";
import { stripInvisibleUnicode } from "../utils/text.js";
import { log } from "../core/logger.js";

/**
 * Block requests to private/internal network addresses to prevent SSRF.
 * Checks the hostname against known private IP ranges and reserved domains.
 */
export function isBlockedUrl(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return true; // Malformed URLs are blocked
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block non-HTTP(S) schemes
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true;
  }

  // Block localhost and loopback
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return true;
  }

  // Block 0.0.0.0
  if (hostname === "0.0.0.0") {
    return true;
  }

  // Block private IPv4 ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;

  // Block link-local (169.254.x.x — includes AWS metadata endpoint)
  if (/^169\.254\./.test(hostname)) return true;

  // Block IPv6 private/link-local
  if (hostname.startsWith("[fe80:") || hostname.startsWith("[fd") || hostname.startsWith("[fc")) {
    return true;
  }

  // Block cloud metadata endpoints
  if (hostname === "metadata.google.internal") return true;

  return false;
}

const BOILERPLATE_SELECTOR_PATTERNS = [
  "script",
  "style",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "nav",
  "footer",
  "header",
  "aside",
  "dialog",
  "cookie",
  "consent",
  "banner",
  "modal",
  "popup",
  "newsletter",
  "subscribe",
  "social",
  "share",
  "sidebar",
  "advert",
  "ads",
  "ad-",
  "-ad",
  "sponsor",
  "promo",
  "tracking",
  "analytics",
];

const BOILERPLATE_LINE_PATTERNS = [
  /^(advertisement|sponsored|promoted|ad)\b/i,
  /^skip to (main content|content|search|navigation)$/i,
  /^open (main )?menu$/i,
  /\b(cookie|privacy) (settings|preferences|policy)\b/i,
  /\b(accept|reject|manage) (all )?(cookies|preferences)\b/i,
  /\bsubscribe (to|for)\b/i,
  /\bsign up for (our )?(newsletter|emails?)\b/i,
  /^share (this|on)\b/i,
];

function removeElementsByTag(html: string, tagName: string): string {
  return html.replace(new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, "gi"), " ");
}

function removeBoilerplateElements(html: string): string {
  let cleaned = html;

  for (const pattern of BOILERPLATE_SELECTOR_PATTERNS) {
    cleaned = cleaned.replace(
      new RegExp(
        `<([a-z][a-z0-9]*)\\b[^>]*(?:id|class|role|aria-label|data-testid|data-test|data-component)=["'][^"']*${pattern}[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>`,
        "gi",
      ),
      " ",
    );
  }

  for (const tagName of [
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "iframe",
    "form",
    "nav",
    "footer",
    "header",
    "aside",
  ]) {
    cleaned = removeElementsByTag(cleaned, tagName);
  }

  return cleaned;
}

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

export function htmlToCleanText(html: string): string {
  const withUsefulBreaks = removeBoilerplateElements(html)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|section|article|main|h[1-6]|li|tr|blockquote)\s*>/gi, "\n");

  return decodeHTMLEntities(withUsefulBreaks.replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !BOILERPLATE_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Outline rendering (compact numbered view) ────────────────

/** Hard cap on how many links one tool call will number. */
const MAX_OUTLINE_LINKS = 100;
/** ~500 tokens of body: the whole point of the outline format. */
const OUTLINE_DEFAULT_MAX_LENGTH = 2000;
/** Per-session render cache size (pages, not bytes). */
const MAX_CACHED_PAGES = 32;
const OUTLINE_INDEX_HEADER = "Links (fetch one with `follow`):";
const BLOCKED_URL_MESSAGE =
  "Error: URL blocked — requests to private/internal network addresses are not allowed.";

/** A hyperlink shown in an outline render as `anchor text [number]`. */
export interface OutlineLink {
  number: number;
  url: string;
}

/**
 * Allocates the small stable numbers that replace hyperlinks in an outline
 * render. Scoped to a single tool call, deduped by absolute URL, and capped at
 * {@link MAX_OUTLINE_LINKS} so a link-farm page cannot grow the index (or the
 * session's follow map) without bound.
 */
class LinkNumbers {
  private readonly byUrl = new Map<string, number>();
  private readonly used = new Set<number>();
  private readonly ordered: OutlineLink[] = [];
  private next = 1;

  get size(): number {
    return this.byUrl.size;
  }

  /** Adopt the numbers baked into a cached render so they stay resolvable. */
  reserve(links: readonly OutlineLink[]): void {
    for (const link of links) {
      if (this.used.has(link.number)) continue;
      this.used.add(link.number);
      this.byUrl.set(link.url, link.number);
      this.ordered.push(link);
    }
  }

  /** Number for `url`, or null once the per-call cap is reached. */
  numberFor(url: string): number | null {
    const existing = this.byUrl.get(url);
    if (existing !== undefined) return existing;
    if (this.byUrl.size >= MAX_OUTLINE_LINKS) return null;
    while (this.used.has(this.next)) this.next++;
    const number = this.next++;
    this.used.add(number);
    this.byUrl.set(url, number);
    this.ordered.push({ number, url });
    return number;
  }

  all(): readonly OutlineLink[] {
    return this.ordered;
  }
}

/** Absolute http(s) form of `href` relative to `base`, or null if unusable. */
function absoluteHttpUrl(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  let resolved: URL;
  try {
    resolved = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  // Fragments only move within a page we already have: drop them so anchors
  // into the same document collapse onto one number, and spend no number at
  // all on links back into the page being rendered.
  resolved.hash = "";
  let self: URL;
  try {
    self = new URL(base);
  } catch {
    return resolved.toString();
  }
  self.hash = "";
  if (resolved.href === self.href) return null;
  return resolved.href;
}

const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(\s*<?([^)<>\s]*)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_ANCHOR = /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

/** Rewrite markdown links to `text [n]`; drop images, which carry no text. */
function numberMarkdownLinks(markdown: string, base: string, numbers: LinkNumbers): string {
  return markdown.replace(MARKDOWN_LINK, (_match, image: string, text: string, href: string) => {
    if (image) return "";
    const url = absoluteHttpUrl(href, base);
    if (!url) return text;
    const number = numbers.numberFor(url);
    return number === null ? text : `${text} [${number}]`;
  });
}

/** Same rewrite for raw HTML, used when the markdown extractor is unavailable. */
function numberHtmlAnchors(html: string, base: string, numbers: LinkNumbers): string {
  return html.replace(HTML_ANCHOR, (_match, href: string, inner: string) => {
    const url = absoluteHttpUrl(decodeHTMLEntities(href), base);
    if (!url) return inner;
    const number = numbers.numberFor(url);
    return number === null ? inner : `${inner} [${number}]`;
  });
}

function compactBlankLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Render a fetched document as main content with every hyperlink replaced by a
 * number, followed by a compact number → absolute URL index. The body reuses
 * the existing `max_length` budget; only links still visible in the (possibly
 * truncated) body are indexed.
 */
async function renderOutline(
  text: string,
  isHtml: boolean,
  finalUrl: string,
  opts: FetchOptions,
): Promise<string> {
  const numbers = opts.numbers ?? new LinkNumbers();
  let heading = "";
  let body: string;

  if (!isHtml) {
    body = numberMarkdownLinks(text, finalUrl, numbers);
  } else {
    let extracted: { markdown: string; title?: string } | null;
    try {
      extracted = await extractToMarkdown(text, finalUrl);
    } catch {
      extracted = null;
    }
    if (extracted) {
      heading = extracted.title ? `# ${extracted.title}\n\n` : "";
      body = numberMarkdownLinks(extracted.markdown, finalUrl, numbers);
    } else {
      body = htmlToCleanText(numberHtmlAnchors(removeBoilerplateElements(text), finalUrl, numbers));
    }
  }

  const rendered = truncate(compactBlankLines(heading + body), opts.maxLength);
  const shown = numbers.all().filter((link) => rendered.includes(`[${link.number}]`));

  let output = rendered;
  if (shown.length > 0) {
    const index = shown.map((link) => `[${link.number}] ${link.url}`).join("\n");
    output += `\n\n${OUTLINE_INDEX_HEADER}\n${index}`;
    if (numbers.size >= MAX_OUTLINE_LINKS) {
      output += `\n[link index truncated at ${MAX_OUTLINE_LINKS}; further links left as plain text]`;
    }
  }

  opts.onRender?.(finalUrl, output, [...shown]);
  return output;
}

/** A page already rendered in this session, keyed by URL + budget. */
interface CachedPage {
  text: string;
  links: OutlineLink[];
}

function cacheKey(url: string, maxLength: number): string {
  return `${maxLength}\u0000${url}`;
}

function cacheGet(cache: Map<string, CachedPage>, key: string): CachedPage | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // Re-insert so Map iteration order stays least-recently-used first.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(cache: Map<string, CachedPage>, key: string, entry: CachedPage): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHED_PAGES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

// ── Fetch configuration ──────────────────────────────────────

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_URLS = 10;
const MAX_CONCURRENCY = 5;
const PER_URL_MIN_BUDGET = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_CONCURRENCY = 3;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const HONEST_USER_AGENT = "ggcoder/1.0 (+https://github.com/KenKaiii/gg-coder)";

const DOC_PATH_PATTERNS = [/\/docs?\b/i, /\/reference\b/i, /\/api\b/i, /\/guide/i, /\/learn\b/i];
const DOC_ROOT_SEGMENTS = new Set(["docs", "doc", "reference", "api", "guide", "learn"]);
const LONG_LLMS_THRESHOLD = 20000;
const DEFAULT_LLMS_CANDIDATE_LIMIT = 6;

type FetchFormat = "markdown" | "text" | "html" | "outline";
type LlmsCandidateKind = "llms" | "llms-full" | "llms-ctx" | "page-md";

interface LlmsCandidate {
  url: string;
  label: string;
  kind: LlmsCandidateKind;
  priority: number;
}

interface FetchOptions {
  maxLength: number;
  format: FetchFormat;
  preferLlmsTxt: boolean;
  /** Network allowlist policy, read lazily (undefined = unrestricted). */
  getNetworkPolicy?: GetNetworkPolicy;
  /** Link-number allocator shared by every page rendered in one tool call. */
  numbers?: LinkNumbers;
  /** Called with each finished outline render so the caller can cache it. */
  onRender?: (finalUrl: string, rendered: string, links: OutlineLink[]) => void;
}

interface RawResponse {
  status: number;
  statusText: string;
  contentType: string;
  contentLength: number | null;
  body: Response;
  finalUrl: string;
}

/** Result of a single-fetch attempt: either a usable response or an error string. */
type FetchOneResult = { ok: true; response: RawResponse } | { ok: false; error: string };

/**
 * Fetch a URL, transparently following safe redirects up to `MAX_REDIRECTS`.
 * Each hop's target is re-validated with `isBlockedUrl` (SSRF) and the abort
 * signal is honored throughout. Returns the final non-redirect response or an
 * error string describing why the fetch could not complete.
 */
function headersForFormat(format: FetchFormat, honestUserAgent = false): Record<string, string> {
  const accept =
    format === "html" || format === "outline"
      ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"
      : format === "markdown"
        ? "text/markdown,text/plain;q=0.9,text/html;q=0.8,*/*;q=0.5"
        : "text/plain,text/html;q=0.9,*/*;q=0.5";
  return {
    "User-Agent": honestUserAgent ? HONEST_USER_AGENT : BROWSER_USER_AGENT,
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
  };
}

async function requestHop(
  url: string,
  signal: AbortSignal,
  format: FetchFormat,
  honestUserAgent = false,
): Promise<Response> {
  return await fetch(url, {
    headers: headersForFormat(format, honestUserAgent),
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
}

async function fetchOne(
  url: string,
  signal: AbortSignal,
  format: FetchFormat,
  getNetworkPolicy?: GetNetworkPolicy,
  onHop?: (url: string) => void,
): Promise<FetchOneResult> {
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    onHop?.(currentUrl);
    signal.throwIfAborted();
    // Every hop — the initial request and each redirect target — is checked, so
    // a redirect can never carry the fetch to a disallowed host.
    const blocked = checkUrlPolicy(currentUrl, getNetworkPolicy);
    if (blocked) return { ok: false, error: `Error: ${blocked}` };

    let response = await requestHop(currentUrl, signal, format);
    if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
      response.body?.cancel().catch(() => undefined);
      response = await requestHop(currentUrl, signal, format, true);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: false,
          error: `Error: HTTP ${response.status} redirect without Location header`,
        };
      }
      const redirectUrl = new URL(location, currentUrl).toString();
      if (isBlockedUrl(redirectUrl)) {
        return {
          ok: false,
          error: "Error: Redirect blocked — target URL is private/internal or unsupported.",
        };
      }
      currentUrl = redirectUrl;
      continue;
    }

    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
    const contentType = response.headers.get("content-type") ?? "";
    const responseByteLimit = byteLimitForResponse(contentType, currentUrl);
    if (
      contentLength !== null &&
      Number.isFinite(contentLength) &&
      contentLength > responseByteLimit
    ) {
      response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        error: `Error: response too large (${contentLength} bytes; limit ${responseByteLimit}).`,
      };
    }
    return {
      ok: true,
      response: {
        status: response.status,
        statusText: response.statusText,
        contentType,
        contentLength:
          contentLength !== null && Number.isFinite(contentLength) ? contentLength : null,
        body: response,
        finalUrl: currentUrl,
      },
    };
  }

  return { ok: false, error: `Error: too many redirects (>${MAX_REDIRECTS})` };
}

export async function readBoundedBody(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("response too large");
        throw new Error(`response too large (${totalBytes} bytes; limit ${maxBytes})`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function truncate(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  // Surrogate-safe: a mid-emoji cut strands a lone surrogate that makes the
  // provider request body invalid JSON on the next turn.
  return sliceHead(content, maxLength) + "\n\n[Content truncated]";
}

function byteLimitForResponse(contentType: string, url: string): number {
  const path = url.toLowerCase().split("?")[0];
  return contentType.includes("application/pdf") || path.endsWith(".pdf")
    ? MAX_PDF_BYTES
    : MAX_RESPONSE_BYTES;
}

function looksLikePdf(contentType: string, url: string, head: Uint8Array): boolean {
  if (contentType.includes("application/pdf")) return true;
  const magic =
    head.length >= 4 &&
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46;
  if (url.toLowerCase().split("?")[0].endsWith(".pdf") && magic) return true;
  return false;
}

/** Process a fetched PDF body into extracted text or an explanatory error. */
async function processPdf(response: RawResponse, maxLength: number): Promise<string> {
  if (response.contentLength !== null && response.contentLength > MAX_PDF_BYTES) {
    return `Error: PDF too large (${response.contentLength} bytes; limit ${MAX_PDF_BYTES}).`;
  }
  const buffer = await response.body.arrayBuffer();
  if (buffer.byteLength > MAX_PDF_BYTES) {
    return `Error: PDF too large (${buffer.byteLength} bytes; limit ${MAX_PDF_BYTES}).`;
  }
  try {
    const { text, pages } = await extractPdfText(new Uint8Array(buffer));
    return `[PDF · ${pages} page${pages === 1 ? "" : "s"}]\n\n${truncate(text.trim(), maxLength)}`;
  } catch (err) {
    if (err instanceof PdfExtractorUnavailable) {
      return "PDF detected but the optional 'unpdf' dependency is not installed. Add it: pnpm add -w unpdf";
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `Error extracting PDF text: ${msg}`;
  }
}

/** Process a fetched HTML/text body into the requested format. */
async function processHtmlOrText(
  response: RawResponse,
  text: string,
  opts: FetchOptions,
): Promise<string> {
  const prefix = text.trimStart().slice(0, 512);
  const genericContentType =
    !response.contentType ||
    /application\/octet-stream|binary\/octet-stream|text\/plain/i.test(response.contentType);
  const isHtml =
    response.contentType.includes("html") ||
    (genericContentType && /^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(prefix));

  if (opts.format === "outline") {
    return await renderOutline(text, isHtml, response.finalUrl, opts);
  }
  if (opts.format === "html") {
    return truncate(text, opts.maxLength);
  }
  if (!isHtml) {
    return truncate(text, opts.maxLength);
  }

  if (opts.format === "text") {
    return truncate(htmlToCleanText(text), opts.maxLength);
  }

  try {
    const extracted = await extractToMarkdown(text, response.finalUrl);
    if (extracted) {
      const heading = extracted.title ? `# ${extracted.title}\n\n` : "";
      return truncate(heading + extracted.markdown, opts.maxLength);
    }
  } catch {
    // Extractor unavailable or failed — fall through to the plain-text path.
  }

  return truncate(htmlToCleanText(text), opts.maxLength);
}

/**
 * Run the full per-URL pipeline (SSRF check → redirects → PDF/HTML/text →
 * format). Never throws: returns content or an `Error: …` string so one bad
 * URL in a multi-URL call doesn't fail the whole call.
 */
async function fetchAndProcess(
  url: string,
  opts: FetchOptions,
  signal: AbortSignal,
): Promise<string> {
  if (isBlockedUrl(url)) {
    return BLOCKED_URL_MESSAGE;
  }

  try {
    return await withNetworkPolicy(
      url,
      opts.getNetworkPolicy,
      signal,
      async (guardSignal, onHop) => {
        const result = await fetchOne(url, guardSignal, opts.format, opts.getNetworkPolicy, onHop);
        if (!result.ok) return result.error;

        const { response } = result;
        if (!(response.status >= 200 && response.status < 300)) {
          return `Error: HTTP ${response.status} ${response.statusText}`;
        }

        const bytes = await readBoundedBody(
          response.body,
          byteLimitForResponse(response.contentType, response.finalUrl),
        );
        const head = bytes.slice(0, 4);

        if (looksLikePdf(response.contentType, response.finalUrl, head)) {
          const pdfResponse: RawResponse = {
            ...response,
            body: new Response(bytes.slice().buffer),
            contentLength: bytes.byteLength,
          };
          return await processPdf(pdfResponse, opts.maxLength);
        }

        const text = new TextDecoder().decode(bytes);
        return await processHtmlOrText(response, text, opts);
      },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Error fetching ${url}: ${msg}`;
  }
}

/** Heuristic: does this URL look like a documentation page worth probing for llms.txt? */
function isDocish(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname.toLowerCase().startsWith("docs.")) return true;
  return DOC_PATH_PATTERNS.some((p) => p.test(parsed.pathname));
}

function addLlmsFileCandidates(
  candidates: LlmsCandidate[],
  baseUrl: string,
  host: string,
  maxLength: number,
  priorityBase: number,
): void {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  candidates.push({
    url: `${base}llms.txt`,
    label: `llms.txt for ${host}`,
    kind: "llms",
    priority: priorityBase,
  });
  candidates.push({
    url: `${base}llms-ctx.txt`,
    label: `llms-ctx.txt for ${host}`,
    kind: "llms-ctx",
    priority: priorityBase + 2,
  });
  if (maxLength >= LONG_LLMS_THRESHOLD) {
    candidates.push({
      url: `${base}llms-full.txt`,
      label: `llms-full.txt for ${host}`,
      kind: "llms-full",
      priority: priorityBase + 3,
    });
    candidates.push({
      url: `${base}llms-ctx-full.txt`,
      label: `llms-ctx-full.txt for ${host}`,
      kind: "llms-ctx",
      priority: priorityBase + 4,
    });
  }
}

export function buildLlmsCandidates(url: string, maxLength: number): LlmsCandidate[] {
  const parsed = new URL(url);
  const candidates: LlmsCandidate[] = [];
  addLlmsFileCandidates(candidates, parsed.origin, parsed.host, maxLength, 10);

  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const docRootIndex = pathSegments.findIndex((segment) =>
    DOC_ROOT_SEGMENTS.has(segment.toLowerCase()),
  );
  if (docRootIndex >= 0) {
    const rootPath = pathSegments
      .slice(0, docRootIndex + 1)
      .map(encodeURIComponent)
      .join("/");
    addLlmsFileCandidates(candidates, `${parsed.origin}/${rootPath}/`, parsed.host, maxLength, 20);
  }

  const pageMarkdownUrl = new URL(parsed.href);
  pageMarkdownUrl.hash = "";
  if (pageMarkdownUrl.pathname.endsWith("/")) {
    pageMarkdownUrl.pathname += "index.html.md";
  } else if (!pageMarkdownUrl.pathname.endsWith(".md")) {
    pageMarkdownUrl.pathname += ".md";
  }
  candidates.push({
    url: pageMarkdownUrl.href,
    label: `Markdown source for ${pageMarkdownUrl.host}${pageMarkdownUrl.pathname}`,
    kind: "page-md",
    priority: 15,
  });

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => a.priority - b.priority)
    .filter((candidate) => {
      if (seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    });
}

function looksLikeHtmlErrorPage(text: string): boolean {
  const trimmed = text.trim().slice(0, 4000).toLowerCase();
  if (/^(<!doctype html|<html\b)/i.test(trimmed)) return true;
  if (/<title>\s*(404|not found|error)\b/i.test(trimmed)) return true;
  const tagMatches = trimmed.match(/<\/?[a-z][^>]*>/g) ?? [];
  return tagMatches.length > 20 && tagMatches.join("").length > trimmed.length * 0.25;
}

function looksLikeMarkdownDocument(
  text: string,
  contentType: string,
  candidate: LlmsCandidate,
): boolean {
  const trimmed = text.trim();
  const minimumLength = candidate.kind === "page-md" ? 80 : 120;
  if (trimmed.length <= minimumLength) return false;
  if (looksLikeHtmlErrorPage(trimmed)) return false;
  if (/text\/plain|text\/markdown|markdown/i.test(contentType)) return true;
  if (/^---\s*[\s\S]{0,1200}?---\s*\n#\s+/m.test(trimmed)) return true;
  if (/^#\s+\S+/m.test(trimmed)) return true;
  const markdownLinks = trimmed.match(/\[[^\]]+\]\([^)]+\)/g) ?? [];
  const listItems = trimmed.match(/^\s*[-*]\s+\S+/gm) ?? [];
  return candidate.kind !== "page-md" && markdownLinks.length + listItems.length >= 3;
}

async function tryLlmsResource(
  url: string,
  opts: FetchOptions,
  signal: AbortSignal,
): Promise<string | null> {
  let candidates: LlmsCandidate[];
  try {
    candidates = buildLlmsCandidates(url, opts.maxLength);
  } catch {
    return null;
  }

  const limit =
    opts.maxLength >= LONG_LLMS_THRESHOLD ? candidates.length : DEFAULT_LLMS_CANDIDATE_LIMIT;
  const eligibleCandidates = candidates
    .slice(0, limit)
    .filter((candidate) => !isBlockedUrl(candidate.url));
  const probes = await runPool(eligibleCandidates, PROBE_CONCURRENCY, async (candidate) => {
    try {
      const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
      return await withNetworkPolicy(
        candidate.url,
        opts.getNetworkPolicy,
        probeSignal,
        async (guardSignal, onHop) => {
          const result = await fetchOne(
            candidate.url,
            guardSignal,
            "markdown",
            opts.getNetworkPolicy,
            onHop,
          );
          if (!result.ok) return null;
          const { response } = result;
          if (response.status !== 200) return null;
          const bytes = await readBoundedBody(response.body);
          const text = new TextDecoder().decode(bytes);
          if (!looksLikeMarkdownDocument(text, response.contentType, candidate)) return null;
          return `[${candidate.label}]\nSource: ${response.finalUrl}\n\n${truncate(text.trim(), opts.maxLength)}`;
        },
      );
    } catch {
      return null;
    }
  });

  return probes.find((probe): probe is string => probe !== null) ?? null;
}

async function fetchWithPreferredDocs(
  url: string,
  opts: FetchOptions,
  signal: AbortSignal,
): Promise<string> {
  if (
    opts.format !== "html" &&
    opts.format !== "outline" &&
    opts.preferLlmsTxt &&
    !isBlockedUrl(url) &&
    isDocish(url)
  ) {
    const llms = await tryLlmsResource(url, opts, signal);
    if (llms) return llms;
  }
  return await fetchAndProcess(url, opts, signal);
}

/**
 * Remove invisible Unicode tag characters from a page before the model reads
 * it. Any page can encode a full ASCII instruction in U+E0000–U+E007F, which
 * renders as nothing in the terminal and in any browser — so the user reviewing
 * the fetch sees innocuous text while the model receives the injected command.
 * Applied at every format, including cached outlines and extracted PDFs.
 */
function sanitizeFetched(url: string, content: string): string {
  const { text, stripped } = stripInvisibleUnicode(content);
  if (stripped > 0) {
    log("WARN", "web-fetch", "Stripped invisible Unicode tag characters from fetched page", {
      url,
      stripped,
    });
  }
  return text;
}

/**
 * Outline-mode wrapper around {@link fetchWithPreferredDocs} that serves
 * repeat views of a page from the per-session cache. The URL is re-validated
 * *before* the cache is consulted, so a cached render can never resurrect a
 * host the current SSRF/allowlist policy forbids.
 *
 * Every path out of the fetch pipeline — PDF, llms.txt, outline, cache hit —
 * returns through here, so {@link sanitizeFetched} applies once and covers all
 * of them.
 */
async function fetchPage(
  url: string,
  opts: FetchOptions,
  signal: AbortSignal,
  cache: Map<string, CachedPage>,
): Promise<string> {
  if (opts.format !== "outline") {
    return sanitizeFetched(url, await fetchWithPreferredDocs(url, opts, signal));
  }

  if (isBlockedUrl(url)) return BLOCKED_URL_MESSAGE;
  const policyError = checkUrlPolicy(url, opts.getNetworkPolicy);
  if (policyError) return `Error: ${policyError}`;

  const requestKey = cacheKey(url, opts.maxLength);
  const hit = cacheGet(cache, requestKey);
  if (hit) {
    opts.numbers?.reserve(hit.links);
    return sanitizeFetched(url, hit.text);
  }

  let rendered: CachedPage | undefined;
  const result = await fetchWithPreferredDocs(
    url,
    {
      ...opts,
      onRender: (finalUrl, text, links) => {
        rendered = { text, links };
        // Keyed by the post-redirect URL, plus the requested URL below.
        cacheSet(cache, cacheKey(finalUrl, opts.maxLength), rendered);
      },
    },
    signal,
  );
  if (rendered) cacheSet(cache, requestKey, rendered);
  return sanitizeFetched(url, result);
}

export function createWebFetchTool(
  getNetworkPolicy?: GetNetworkPolicy,
): AgentTool<typeof parameters> {
  // Per-session state, both bounded: the render cache evicts least-recently
  // used pages past MAX_CACHED_PAGES, and the follow map is replaced (not
  // grown) by each outline call, itself capped at MAX_OUTLINE_LINKS entries.
  const pageCache = new Map<string, CachedPage>();
  let followTargets = new Map<number, string>();

  return {
    name: "web_fetch",
    description:
      "Fetch and read web page content. Accepts a single `url` or a `urls` array (up to 10, " +
      "fetched concurrently). Returns clean Markdown by default (`format`: markdown|text|html|outline) " +
      "via main-content extraction. Extracts text from PDFs, follows safe redirects automatically, and " +
      "prefers a site's curated /llms.txt for docs pages when available.\n" +
      '`format: "outline"` is the cheap mode: main content only, every hyperlink replaced by a ' +
      "number (`anchor text [12]`) with a numbered URL index at the end, and a small default " +
      "`max_length`. Use it when hunting for the right page; then pass `follow: 12` " +
      "(instead of `url`) to fetch link 12 from the last outline. Repeat views of a page in the " +
      "same session are served from cache. Outline mode skips the /llms.txt probe.",
    parameters,
    async execute(args, context: ToolContext) {
      const format: FetchFormat = args.format ?? "markdown";
      const maxLength =
        args.max_length ?? (format === "outline" ? OUTLINE_DEFAULT_MAX_LENGTH : 10000);
      const preferLlmsTxt = args.prefer_llms_txt !== false;
      const numbers = format === "outline" ? new LinkNumbers() : undefined;

      // A followed link is attacker-controlled page content: it resolves to a
      // plain URL here and then travels the exact same validation path as a
      // user-supplied one (isBlockedUrl + allowlist + per-redirect-hop checks).
      let followUrl: string | undefined;
      if (args.follow !== undefined) {
        followUrl = followTargets.get(args.follow);
        if (!followUrl) {
          return followTargets.size === 0
            ? 'Error: no numbered links available — fetch a page with format: "outline" first.'
            : `Error: link [${args.follow}] is not in the last outline (known: ${[...followTargets.keys()].join(", ")}).`;
        }
      }

      // Every outline render replaces the follow map, even when the page had no
      // links: keeping the previous page's numbers would make `follow: 3` fetch
      // from a page the user already moved past, while the error text and the
      // tool description both promise "the last outline". Non-outline fetches
      // leave the map alone, so a markdown read does not discard usable numbers.
      const remember = <T>(output: T): T => {
        if (numbers) {
          followTargets = new Map(numbers.all().map((link) => [link.number, link.url]));
        }
        return output;
      };

      // Multi-URL path: bounded-concurrency pool, per-URL budget, ordered output.
      if (!followUrl && args.urls && args.urls.length > 0) {
        const urls = args.urls;
        const perUrlBudget = Math.max(PER_URL_MIN_BUDGET, Math.floor(maxLength / urls.length));
        const opts: FetchOptions = {
          maxLength: perUrlBudget,
          format,
          preferLlmsTxt,
          getNetworkPolicy,
          numbers,
        };
        const sections = await runPool(urls, MAX_CONCURRENCY, (u) =>
          fetchPage(u, opts, context.signal, pageCache),
        );
        return remember(urls.map((u, i) => `## ${u}\n${sections[i]}`).join("\n\n"));
      }

      const url = followUrl ?? args.url;
      if (!url) {
        return "Error: provide either `url`, `urls`, or `follow`.";
      }

      const opts: FetchOptions = { maxLength, format, preferLlmsTxt, getNetworkPolicy, numbers };
      return remember(await fetchPage(url, opts, context.signal, pageCache));
    },
  };
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the returned results array.
 */
async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function runner(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(runners);
  return results;
}

const parameters = z
  .object({
    url: z.string().optional().describe("The URL to fetch"),
    urls: z
      .array(z.string())
      .max(MAX_URLS)
      .optional()
      .describe(`Fetch multiple URLs concurrently (up to ${MAX_URLS}); returns a sectioned digest`),
    follow: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Fetch link N from the most recent outline render, instead of `url`. " +
          "Followed links are SSRF/allowlist-checked exactly like a supplied URL.",
      ),
    max_length: z
      .number()
      .optional()
      .describe(
        `Maximum characters to return (default: 10000; ${OUTLINE_DEFAULT_MAX_LENGTH} for outline)`,
      ),
    format: z
      .enum(["markdown", "text", "html", "outline"])
      .optional()
      .describe(
        "Output format: markdown (default, main-content extraction), text, html, or outline " +
          `(compact main content with each link replaced by a number plus a numbered URL index, ` +
          `capped at ${MAX_OUTLINE_LINKS} links — cheapest; follow links with \`follow\`)`,
      ),
    prefer_llms_txt: z
      .boolean()
      .optional()
      .describe("Prefer a site's curated /llms.txt for documentation pages (default: true)"),
  })
  .refine(
    (v) =>
      [Boolean(v.url), Boolean(v.urls && v.urls.length > 0), v.follow !== undefined].filter(Boolean)
        .length === 1,
    { message: "Provide exactly one of `url`, `urls`, or `follow`." },
  );
