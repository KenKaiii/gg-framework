import type * as GgAi from "@kenkaiiii/gg-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.fn();
vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => ({
  ...(await importOriginal<typeof GgAi>()),
  stream: (...args: unknown[]) => streamMock(...args),
}));

const { runSideWebSearch, SIDE_SEARCH_MODEL } = await import("./side-web-search.js");
const { createWebSearchTool } = await import("./web-search.js");

const usage = {
  inputTokens: 900,
  outputTokens: 120,
  cacheRead: 0,
  cacheWrite: 0,
  serverToolUse: { webSearchRequests: 1 },
};
const searchResult = (content: unknown) => ({
  type: "server_tool_result",
  toolUseId: "srvtoolu_1",
  resultType: "web_search_tool_result",
  data: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content },
});
const respond = (parts: unknown[]) =>
  streamMock.mockReturnValue({
    response: Promise.resolve({
      message: { role: "assistant", content: parts },
      stopReason: "end_turn",
      usage,
    }),
  });
const request = (extra: Record<string, unknown> = {}) => ({
  query: "anthropic inline tools",
  maxResults: 2,
  includeDomains: [],
  excludeDomains: [],
  signal: new AbortController().signal,
  ...extra,
});

afterEach(() => streamMock.mockReset());

describe("runSideWebSearch", () => {
  it("returns titles, URLs and a short summary, never the result pages", async () => {
    respond([
      { type: "server_tool_call", id: "srvtoolu_1", name: "web_search", input: { query: "x" } },
      searchResult([
        {
          type: "web_search_result",
          title: "Mid-conversation system messages",
          url: "https://a.example/docs",
          page_age: "2 weeks ago",
          encrypted_content: "E".repeat(20_000),
        },
        {
          type: "web_search_result",
          title: "Tool use",
          url: "https://b.example/tools",
          encrypted_content: "E".repeat(20_000),
        },
        { type: "web_search_result", title: "Third", url: "https://c.example/" },
      ]),
      {
        type: "text",
        text: "Inline tools need the inline-tools-2026-09-15 beta (Mid-conversation system messages).",
      },
    ]);

    const result = await runSideWebSearch(request(), { apiKey: "sk-ant-oat-test" });

    expect(result.text).toContain(
      "1. [Mid-conversation system messages](https://a.example/docs) · 2 weeks ago",
    );
    expect(result.text).toContain("2. [Tool use](https://b.example/tools)");
    expect(result.text).not.toContain("c.example");
    expect(result.text).toContain("inline-tools-2026-09-15 beta");
    expect(result.text).not.toContain("EEEE");
    expect(result.text.length).toBeLessThan(1_000);
    expect(result.usage).toEqual(usage);
    expect(result.model).toBe(SIDE_SEARCH_MODEL);
  });

  it("asks a small model for one search and passes domain filters to the server tool", async () => {
    respond([searchResult([]), { type: "text", text: "Nothing found." }]);

    await runSideWebSearch(
      request({ includeDomains: ["platform.claude.com"], timeRange: "month" }),
      { apiKey: "k" },
    );

    const options = streamMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.provider).toBe("anthropic");
    expect(options.model).toBe(SIDE_SEARCH_MODEL);
    expect(options.serverTools).toEqual([
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 1,
        allowed_domains: ["platform.claude.com"],
      },
    ]);
    expect(JSON.stringify(options.messages)).toContain("past month");
  });

  it("throws on a server search error so the tool can fall back", async () => {
    respond([
      searchResult({ type: "web_search_tool_result_error", error_code: "too_many_requests" }),
    ]);

    await expect(runSideWebSearch(request(), { apiKey: "k" })).rejects.toThrow("too_many_requests");
  });
});

describe("web_search tool with a side search", () => {
  const context = () => ({ signal: new AbortController().signal, toolCallId: "t" });

  it("returns the side search result and reports its usage", async () => {
    const side = vi.fn(async () => ({
      text: 'Web search results for: "q"',
      usage,
      model: SIDE_SEARCH_MODEL,
    }));

    const result = await createWebSearchTool(undefined, side).execute({ query: "q" }, context());

    expect(result).toEqual({
      content: 'Web search results for: "q"',
      details: { engine: "anthropic", model: SIDE_SEARCH_MODEL, usage },
    });
    expect(side).toHaveBeenCalledWith(expect.objectContaining({ query: "q", maxResults: 5 }));
  });

  it("falls back to the engine search when the side search fails", async () => {
    const side = vi.fn(async () => {
      throw new Error("web search failed: unavailable");
    });
    globalThis.fetch = vi.fn(
      async () => new Response("<html></html>", { status: 200 }),
    ) as typeof fetch;

    const result = await createWebSearchTool(undefined, side).execute(
      { query: "zzqv nothing" },
      context(),
    );

    expect(side).toHaveBeenCalledTimes(1);
    expect(String(result)).toContain("No search results found");
  });
});
