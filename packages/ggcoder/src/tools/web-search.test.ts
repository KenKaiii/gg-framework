import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool, isAdSearchResultUrl } from "./web-search.js";

const originalFetch = globalThis.fetch;

function context() {
  return { signal: new AbortController().signal, toolCallId: "test" };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("isAdSearchResultUrl", () => {
  it("blocks DuckDuckGo ad redirects", () => {
    const url =
      "https://duckduckgo.com/y.js?ad_domain=nordvpn.com&ad_provider=bingv7aa&ad_type=txad&u3=https%3A%2F%2Fwww.bing.com%2Faclick%3Fld%3Dabc";

    expect(isAdSearchResultUrl(url)).toBe(true);
  });

  it("blocks Bing and Google click-tracking ad URLs", () => {
    expect(isAdSearchResultUrl("https://www.bing.com/aclick?ld=abc&msclkid=123")).toBe(true);
    expect(
      isAdSearchResultUrl("https://www.google.com/aclk?sa=l&adurl=https%3A%2F%2Fexample.com"),
    ).toBe(true);
  });

  it("allows ordinary organic result URLs", () => {
    expect(isAdSearchResultUrl("https://developer.mozilla.org/en-US/docs/Web/API/fetch")).toBe(
      false,
    );
    expect(isAdSearchResultUrl("/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2F")).toBe(
      false,
    );
  });
});

describe("createWebSearchTool", () => {
  it("filters ad results from live parser output before returning organic results", async () => {
    const html = `
      <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=nordvpn.com&ad_provider=bingv7aa&ad_type=txad&u3=https%3A%2F%2Fwww.bing.com%2Faclick%3Fld%3Dabc">Limited-time NordVPN offer</a>
      <a class="result__snippet">Sponsored VPN discount.</a>
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FAPI%2FFetch_API">Fetch API - MDN</a>
      <a class="result__snippet">The Fetch API provides an interface for fetching resources.</a>
    `;
    globalThis.fetch = vi.fn(async () => new Response(html, { status: 200 })) as typeof fetch;

    const result = await createWebSearchTool().execute(
      { query: "fetch api", max_results: 5 },
      context(),
    );

    expect(result).toContain("Fetch API - MDN");
    expect(result).toContain("https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API");
    expect(result).not.toContain("NordVPN");
    expect(result).not.toContain("ad_domain");
  });

  it("parses DuckDuckGo result blocks with titles and snippets", async () => {
    const html = `
      <div class="result results_links results_links_deep web-result">
        <h2 class="result__title">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2F">TypeScript Documentation</a>
        </h2>
        <a class="result__snippet">TypeScript documentation and handbook.</a>
      </div>
    `;
    globalThis.fetch = vi.fn(async () => new Response(html, { status: 200 })) as typeof fetch;

    const result = await createWebSearchTool().execute(
      { query: "typescript docs", max_results: 5 },
      context(),
    );

    expect(result).toContain("TypeScript Documentation");
    expect(result).toContain("https://www.typescriptlang.org/docs/");
    expect(result).toContain("TypeScript documentation and handbook.");
  });

  it("parses Google result blocks and unwraps Google redirect URLs", async () => {
    const emptyHtml = "<html></html>";
    const googleHtml = `
      <div class="g">
        <a href="/url?q=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FAPI%2FFetch_API&sa=U"><h3>Fetch API - MDN</h3></a>
        <div class="VwiC3b">The Fetch API provides an interface for fetching resources.</div>
      </div>
    `;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(emptyHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(emptyHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(emptyHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(emptyHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(googleHtml, { status: 200 })) as typeof fetch;

    const result = await createWebSearchTool().execute(
      { query: "fetch api mdn", max_results: 5 },
      context(),
    );

    expect(result).toContain("Fetch API - MDN");
    expect(result).toContain("https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API");
    expect(result).toContain("The Fetch API provides an interface for fetching resources.");
    expect(result).toContain("from Google");
  });

  it("falls back to the next search engine when one returns only ads", async () => {
    const adOnlyHtml = `
      <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=oneclearwinner.com&ad_provider=bingv7aa&ad_type=txad">Cheap laptops for sale</a>
      <a class="result__snippet">Sponsored laptop deals.</a>
    `;
    const braveHtml = `
      <div class="snippet">
        <a href="https://example.com/organic" class="result-header">Organic result</a>
        <p class="snippet-description">Useful organic snippet.</p>
      </div></div>
    `;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(adOnlyHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(adOnlyHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(braveHtml, { status: 200 })) as typeof fetch;

    const result = await createWebSearchTool().execute(
      { query: "laptop deals", max_results: 5 },
      context(),
    );

    expect(result).toContain("Organic result");
    expect(result).toContain("https://example.com/organic");
    expect(result).toContain("from Brave");
    expect(result).not.toContain("Cheap laptops for sale");
  });

  it("uses Bing as a fallback and unwraps Bing redirect URLs", async () => {
    const blockedHtml = "<html>captcha blocked challenge-form</html>";
    const bingURL = `https://www.bing.com/ck/a?u=a1${Buffer.from(
      "https://www.typescriptlang.org/docs/",
      "utf8",
    ).toString("base64url")}`;
    const bingHtml = `
      <li class="b_algo">
        <h2><a href="${bingURL}">TypeScript Documentation</a></h2>
        <div class="b_caption"><p>Learn TypeScript from the official docs.</p></div>
      </li>
    `;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(blockedHtml, { status: 202 }))
      .mockResolvedValueOnce(new Response(blockedHtml, { status: 202 }))
      .mockResolvedValueOnce(new Response(blockedHtml, { status: 429 }))
      .mockResolvedValueOnce(new Response(bingHtml, { status: 200 })) as typeof fetch;

    const result = await createWebSearchTool().execute(
      { query: "TypeScript official documentation", max_results: 5 },
      context(),
    );

    expect(result).toContain("TypeScript Documentation");
    expect(result).toContain("https://www.typescriptlang.org/docs/");
    expect(result).toContain("from Bing");
  });
});
