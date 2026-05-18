import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

const RATE_LIMIT_PATTERNS = [
  "you appear to be a bot",
  "unusual traffic",
  "captcha",
  "rate limit",
  "too many requests",
  "blocked",
  "access denied",
  "sorry, you have been blocked",
  "anomaly-modal",
  "unfortunately, bots use duckduckgo",
  "challenge-form",
];

type SearchEngine = "DuckDuckGo" | "DuckDuckGoLite" | "Brave" | "Bing" | "Google";
const ENGINES: SearchEngine[] = ["DuckDuckGo", "DuckDuckGoLite", "Brave", "Bing", "Google"];

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const AD_URL_PATTERNS = [
  /(?:^|\.)googleadservices\.com$/i,
  /(?:^|\.)doubleclick\.net$/i,
  /(?:^|\.)googlesyndication\.com$/i,
  /(?:^|\.)adsystem\.com$/i,
  /(?:^|\.)adnxs\.com$/i,
  /(?:^|\.)taboola\.com$/i,
  /(?:^|\.)outbrain\.com$/i,
];

const AD_QUERY_KEYS = new Set([
  "ad_domain",
  "ad_provider",
  "ad_type",
  "adurl",
  "adurlurl",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
]);

const AD_PATH_PATTERNS = [/^\/y\.js$/i, /^\/aclk$/i, /^\/aclick$/i, /^\/pagead\//i];

// ── HTML helpers ──────────────────────────────────────────

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

function cleanHTML(text: string): string {
  return decodeHTMLEntities(text.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

export function isAdSearchResultUrl(rawURL: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawURL, "https://duckduckgo.com");
  } catch {
    return true;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (AD_URL_PATTERNS.some((pattern) => pattern.test(hostname))) return true;
  if (AD_PATH_PATTERNS.some((pattern) => pattern.test(parsed.pathname))) return true;

  for (const key of parsed.searchParams.keys()) {
    if (AD_QUERY_KEYS.has(key.toLowerCase())) return true;
  }

  const nestedURL = parsed.searchParams.get("u3") ?? parsed.searchParams.get("adurl");
  if (nestedURL && isAdSearchResultUrl(nestedURL)) return true;

  return false;
}

function isAdSearchResult(result: SearchResult): boolean {
  if (isAdSearchResultUrl(result.url)) return true;
  const combinedText = `${result.title} ${result.snippet}`.toLowerCase();
  return /\b(sponsored|advertisement|promoted result|exclusive discounts|limited-time offer)\b/.test(
    combinedText,
  );
}

function filterSearchResults(results: SearchResult[], maxResults: number): SearchResult[] {
  const filtered: SearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const result of results) {
    if (isAdSearchResult(result)) continue;
    if (seenUrls.has(result.url)) continue;
    seenUrls.add(result.url);
    filtered.push(result);
    if (filtered.length >= maxResults) break;
  }

  return filtered;
}

// ── Request building ─────────────────────────────────────

function buildRequest(engine: SearchEngine, query: string) {
  const encoded = encodeURIComponent(query);
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  const headers: Record<string, string> = {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  let url: string;
  let method = "GET";
  let body: string | undefined;

  switch (engine) {
    case "DuckDuckGo":
      url = `https://html.duckduckgo.com/html/?q=${encoded}`;
      break;
    case "DuckDuckGoLite":
      url = "https://lite.duckduckgo.com/lite/";
      method = "POST";
      body = new URLSearchParams({ q: query }).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      break;
    case "Brave":
      url = `https://search.brave.com/search?q=${encoded}&source=web`;
      headers.Accept = "text/html";
      break;
    case "Bing":
      url = `https://www.bing.com/search?q=${encoded}`;
      headers.Accept = "text/html";
      break;
    case "Google":
      url = `https://www.google.com/search?q=${encoded}&hl=en`;
      break;
  }

  return { url, headers, method, body };
}

// ── Fetch with retry ─────────────────────────────────────

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  method = "GET",
  body?: string,
  maxRetries = 3,
): Promise<{ data: string; statusCode: number }> {
  let lastError: Error = new Error("No attempts made");

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const baseDelay = Math.pow(2, attempt - 1) * 1000;
      const jitter = 1 + Math.random() * 0.5;
      await new Promise((r) => setTimeout(r, baseDelay * jitter));
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body ? { body } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      const text = await response.text();
      return { data: text, statusCode: response.status };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError;
}

// ── Rate limit detection ─────────────────────────────────

function isRateLimited(statusCode: number, html: string): boolean {
  if ([429, 403, 503].includes(statusCode)) return true;
  const lower = html.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

// ── Parsers ──────────────────────────────────────────────

function getAttributeValue(html: string, attribute: string): string {
  const match = html.match(new RegExp(`${attribute}=["']([^"']+)["']`, "i"));
  return match?.[1] ?? "";
}

function parseDDGResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const blockRegex =
    /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bresult\b|<\/body>|$)/g;
  const fallbackLinkRegex =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;

  for (const block of html.matchAll(blockRegex)) {
    const blockHTML = block[1];
    const linkMatch = blockHTML.match(
      /<a[^>]*class="[^"]*(?:result__a|result__title)[^"]*"[^>]*>[\s\S]*?<\/a>/i,
    );
    if (!linkMatch) continue;

    const rawLink = linkMatch[0];
    const rawURL = getAttributeValue(rawLink, "href");
    const title = cleanHTML(rawLink);
    const snippetMatch = blockHTML.match(
      /<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i,
    );
    const snippet = snippetMatch ? cleanHTML(snippetMatch[1]) : "";
    const url = unwrapDDGRedirect(rawURL);

    if (url && title) {
      results.push({ title, url, snippet });
    }
  }

  if (results.length > 0) return results;

  for (const link of html.matchAll(fallbackLinkRegex)) {
    const [, rawURL, rawTitle] = link;
    const url = unwrapDDGRedirect(rawURL);
    const title = cleanHTML(rawTitle);
    if (url && title) {
      results.push({ title, url, snippet: "" });
    }
  }

  return results;
}

function unwrapDDGRedirect(rawURL: string): string {
  if (rawURL.includes("uddg=")) {
    try {
      const params = new URL(rawURL, "https://duckduckgo.com").searchParams;
      const uddg = params.get("uddg");
      if (uddg) return uddg;
    } catch {
      // fall through
    }
  }
  if (rawURL.startsWith("//")) return "https:" + rawURL;
  return rawURL;
}

function unwrapBingRedirect(rawURL: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawURL, "https://www.bing.com");
  } catch {
    return rawURL;
  }

  const encodedURL = parsed.searchParams.get("u");
  if (!encodedURL) return parsed.href;

  try {
    const base64URL = encodedURL.startsWith("a1") ? encodedURL.slice(2) : encodedURL;
    return Buffer.from(base64URL, "base64url").toString("utf8");
  } catch {
    return parsed.href;
  }
}

function parseBraveResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const blockRegex = /<div[^>]*class="snippet[^"]*"[^>]*>(.*?)<\/div>\s*<\/div>/gs;
  const linkRegex = /<a[^>]*href="([^"]*)"[^>]*class="[^"]*result-header[^"]*"[^>]*>(.*?)<\/a>/s;
  const descRegex = /<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>(.*?)<\/p>/s;

  for (const block of html.matchAll(blockRegex)) {
    const blockHTML = block[1];
    const linkMatch = blockHTML.match(linkRegex);
    if (!linkMatch) continue;

    const url = linkMatch[1];
    const title = cleanHTML(linkMatch[2]);
    const descMatch = blockHTML.match(descRegex);
    const snippet = descMatch ? cleanHTML(descMatch[1]) : "";

    if (url && title) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function parseBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const blockRegex =
    /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?[\s\S]*?<\/li>/g;

  for (const block of html.matchAll(blockRegex)) {
    const [, rawURL, rawTitle, rawSnippet = ""] = block;
    const url = unwrapBingRedirect(decodeHTMLEntities(rawURL));
    const title = cleanHTML(rawTitle);
    const snippet = cleanHTML(rawSnippet);

    if (url && title) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function unwrapGoogleRedirect(rawURL: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawURL, "https://www.google.com");
  } catch {
    return rawURL;
  }

  if (parsed.pathname === "/url") {
    const resultURL = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
    if (resultURL) return resultURL;
  }

  return parsed.href;
}

function parseGoogleResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const blockRegex =
    /<div[^>]*class="[^"]*\bg\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bg\b|<\/body>|$)/g;
  const fallbackBlockRegex =
    /<div[^>]*data-hveid="[^"]+"[^>]*>([\s\S]*?)(?=<div[^>]*data-hveid="[^"]+"|<\/body>|$)/g;

  for (const regex of [blockRegex, fallbackBlockRegex]) {
    for (const block of html.matchAll(regex)) {
      const blockHTML = block[1];
      const titleMatch = blockHTML.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      const linkMatch = blockHTML.match(/<a[^>]*href="([^"]+)"[^>]*>/i);
      if (!titleMatch || !linkMatch) continue;

      const snippetMatch = blockHTML.match(
        /<div[^>]*(?:class="[^"]*(?:VwiC3b|yDYNvb)[^"]*"|data-sncf="[^"]*")[^>]*>([\s\S]*?)<\/div>/i,
      );
      const url = unwrapGoogleRedirect(decodeHTMLEntities(linkMatch[1]));
      const title = cleanHTML(titleMatch[1]);
      const snippet = snippetMatch ? cleanHTML(snippetMatch[1]) : "";

      if (url.startsWith("http") && title) {
        results.push({ title, url, snippet });
      }
    }

    if (results.length > 0) break;
  }

  return results;
}

// ── Search cascade ───────────────────────────────────────

async function performSearch(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<{ results: SearchResult[]; engine: SearchEngine }> {
  for (const engine of ENGINES) {
    try {
      const { url, headers, method, body } = buildRequest(engine, query);
      const { data: html, statusCode } = await fetchWithRetry(url, headers, signal, method, body);

      if (isRateLimited(statusCode, html)) continue;

      let results: SearchResult[];
      switch (engine) {
        case "DuckDuckGo":
        case "DuckDuckGoLite":
          results = parseDDGResults(html);
          break;
        case "Brave":
          results = parseBraveResults(html);
          break;
        case "Bing":
          results = parseBingResults(html);
          break;
        case "Google":
          results = parseGoogleResults(html);
          break;
      }

      const filteredResults = filterSearchResults(results, maxResults);
      if (filteredResults.length > 0) {
        return { results: filteredResults, engine };
      }
    } catch {
      // try next engine
    }
  }

  return { results: [], engine: "DuckDuckGo" };
}

// ── Tool definition ──────────────────────────────────────

const parameters = z.object({
  query: z.string().describe("Search query"),
  max_results: z.number().optional().describe("Max results to return (default: 5, max: 20)"),
});

export function createWebSearchTool(): AgentTool<typeof parameters> {
  return {
    name: "web_search",
    description:
      "Search the web and return results. Use for current information, recent events, or facts beyond your knowledge cutoff.",
    parameters,
    async execute(args, context) {
      const maxResults = Math.min(args.max_results ?? 5, 20);

      const { results, engine } = await performSearch(args.query, maxResults, context.signal);

      if (results.length === 0) {
        return `No search results found for: "${args.query}". All search engines were unavailable or returned no results.`;
      }

      let output = `Web search results for: "${args.query}"\n\n`;
      for (let i = 0; i < results.length; i++) {
        output += `${i + 1}. [${results[i].title}](${results[i].url})\n`;
        if (results[i].snippet) {
          output += `   ${results[i].snippet}\n`;
        }
        output += "\n";
      }
      output += `(${results.length} results from ${engine})`;

      return output;
    },
  };
}
