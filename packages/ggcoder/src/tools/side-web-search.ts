import { stream, type ServerToolDefinition, type Usage } from "@kenkaiiii/gg-ai";
import { claudeCodeComplete, type ClaudeCodeProcess } from "../core/claude-code/complete.js";

export interface SideSearchRequest {
  query: string;
  maxResults: number;
  includeDomains: string[];
  excludeDomains: string[];
  timeRange?: "day" | "week" | "month" | "year";
  signal: AbortSignal;
}

export interface SideSearchResult {
  text: string;
  usage: Usage;
  model: string;
}

/** Returns null when the session's provider has no side search (the caller falls back). */
export type SideWebSearch = (request: SideSearchRequest) => Promise<SideSearchResult | null>;

export interface SideSearchCredentials {
  apiKey: string;
  baseUrl?: string;
}

// Anthropic's server search runs in its own small request so the result pages
// (11–20k tokens each in agent-race) never enter the main model's context.
export const SIDE_SEARCH_MODEL = "claude-haiku-5-5";
const SUMMARY_MAX_CHARS = 2_000;

interface WebSearchHit {
  title: string;
  url: string;
  pageAge?: string;
}

function hitsOf(data: unknown): WebSearchHit[] {
  const block = data as { type?: unknown; content?: unknown; error_code?: unknown } | undefined;
  if (block?.type !== "web_search_tool_result") return [];
  const content = block.content as { type?: unknown; error_code?: unknown } | unknown[] | undefined;
  if (!Array.isArray(content)) {
    const code = (content as { error_code?: unknown } | undefined)?.error_code;
    throw new Error(`web search failed: ${typeof code === "string" ? code : "unknown error"}`);
  }
  const hits: WebSearchHit[] = [];
  for (const item of content) {
    const r = item as { type?: unknown; title?: unknown; url?: unknown; page_age?: unknown };
    if (r.type !== "web_search_result" || typeof r.url !== "string") continue;
    hits.push({
      title: typeof r.title === "string" ? r.title : r.url,
      url: r.url,
      ...(typeof r.page_age === "string" ? { pageAge: r.page_age } : {}),
    });
  }
  return hits;
}

export function formatSideSearch(
  query: string,
  hits: WebSearchHit[],
  summary: string,
  maxResults: number,
): string {
  const shown = hits.slice(0, maxResults);
  let out = `Web search results for: "${query}"\n\n`;
  shown.forEach((hit, i) => {
    out += `${i + 1}. [${hit.title}](${hit.url})${hit.pageAge ? ` · ${hit.pageAge}` : ""}\n`;
  });
  const trimmed = summary.trim();
  if (trimmed) {
    const capped =
      trimmed.length > SUMMARY_MAX_CHARS ? `${trimmed.slice(0, SUMMARY_MAX_CHARS)}…` : trimmed;
    out += `\nSummary of the results:\n${capped}\n`;
  }
  out += `\n(${shown.length} results via Anthropic web search; open a page with web_fetch for details)`;
  return out;
}

export async function runSideWebSearch(
  request: SideSearchRequest,
  credentials: SideSearchCredentials,
): Promise<SideSearchResult> {
  const searchTool: ServerToolDefinition = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 1,
    ...(request.includeDomains.length > 0 ? { allowed_domains: request.includeDomains } : {}),
    ...(request.excludeDomains.length > 0 ? { blocked_domains: request.excludeDomains } : {}),
  };
  const recency = request.timeRange ? ` Prefer results from the past ${request.timeRange}.` : "";
  const result = stream({
    provider: "anthropic",
    model: SIDE_SEARCH_MODEL,
    messages: [
      {
        role: "user",
        content:
          `Search the web once for: ${request.query}${recency}\n\n` +
          "Then state, in at most 150 words, the facts from the results that answer the query, " +
          "naming the result title each fact comes from. No preamble.",
      },
    ],
    serverTools: [searchTool],
    maxTokens: 1_024,
    apiKey: credentials.apiKey,
    ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
    signal: request.signal,
  });
  const response = await result.response;
  const content = response.message.content;
  const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  const hits: WebSearchHit[] = [];
  let summary = "";
  for (const part of parts) {
    if (part.type === "server_tool_result") hits.push(...hitsOf(part.data));
    else if (part.type === "text") summary += part.text;
  }
  return {
    text: formatSideSearch(request.query, hits, summary, request.maxResults),
    usage: response.usage,
    model: SIDE_SEARCH_MODEL,
  };
}

/** Hits from Claude Code's `WebSearch` output (`results[].content[]`). */
export function claudeCodeSearchHits(outputs: readonly unknown[]): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  for (const output of outputs) {
    const results = (output as { results?: unknown } | null | undefined)?.results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      const content = (result as { content?: unknown } | null)?.content;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        const r = item as { title?: unknown; url?: unknown };
        if (typeof r.url !== "string") continue;
        hits.push({ title: typeof r.title === "string" ? r.title : r.url, url: r.url });
      }
    }
  }
  return hits;
}

/** The same side search on a Claude subscription, through Claude Code's WebSearch tool. */
export async function runSideWebSearchViaClaudeCode(
  request: SideSearchRequest,
  process: ClaudeCodeProcess,
): Promise<SideSearchResult> {
  const domains = [
    request.includeDomains.length > 0
      ? ` Only use these domains (allowed_domains): ${request.includeDomains.join(", ")}.`
      : "",
    request.excludeDomains.length > 0
      ? ` Exclude these domains (blocked_domains): ${request.excludeDomains.join(", ")}.`
      : "",
  ].join("");
  const recency = request.timeRange ? ` Prefer results from the past ${request.timeRange}.` : "";
  const response = await claudeCodeComplete({
    ...process,
    model: SIDE_SEARCH_MODEL,
    messages: [
      {
        role: "user",
        content:
          `Use the WebSearch tool once for: ${request.query}${domains}${recency}\n\n` +
          "Then state, in at most 150 words, the facts from the results that answer the query, " +
          "naming the result title each fact comes from. No preamble.",
      },
    ],
    builtinTools: ["WebSearch"],
    maxTurns: 2,
    signal: request.signal,
  });
  const content = response.message.content;
  const summary =
    typeof content === "string"
      ? content
      : content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  return {
    text: formatSideSearch(
      request.query,
      claudeCodeSearchHits(response.toolOutputs),
      summary,
      request.maxResults,
    ),
    usage: response.usage,
    model: SIDE_SEARCH_MODEL,
  };
}
