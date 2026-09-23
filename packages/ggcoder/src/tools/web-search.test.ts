import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalSearchResultUrl,
  createWebSearchTool,
  isAdSearchResultUrl,
  isSearchResultRelevant,
  normalizeDomain,
  parseSearchResults,
  resetWebSearchCache,
} from "./web-search.js";

const originalFetch = globalThis.fetch;

function context() {
  return { signal: new AbortController().signal, toolCallId: "test" };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetWebSearchCache();
  vi.restoreAllMocks();
});

describe("search result relevance", () => {
  it("rejects generic localized fallback results while keeping query matches", () => {
    expect(
      isSearchResultRelevant(
        {
          title: "MyGovernment - Government of Malaysia's Official Portal",
          url: "https://www.malaysia.gov.my/en",
          snippet: "Government services and information",
        },
        "official Node.js current release",
      ),
    ).toBe(false);
    expect(
      isSearchResultRelevant(
        {
          title: "Node.js releases",
          url: "https://nodejs.org/en/blog/release",
          snippet: "Current Node.js release information",
        },
        "official Node.js current release",
      ),
    ).toBe(true);
  });
});

describe("canonicalSearchResultUrl", () => {
  it("strips tracking params and fragments while sorting remaining params", () => {
    expect(
      canonicalSearchResultUrl("https://example.com/docs?utm_source=x&b=2&a=1&fbclid=abc#section"),
    ).toBe("https://example.com/docs?a=1&b=2");
  });

  it("unwraps nested redirect params safely", () => {
    expect(
      canonicalSearchResultUrl(
        "/l/?url=https%3A%2F%2Fexample.com%2Fguide%3Futm_medium%3Dcpc%26x%3D1",
      ),
    ).toBe("https://example.com/guide?x=1");
    expect(
      canonicalSearchResultUrl(
        "https://duckduckgo.com/y.js?u3=https%3A%2F%2Fwww.bing.com%2Faclick%3Fld%3Dabc",
      ),
    ).toBeNull();
    expect(canonicalSearchResultUrl("javascript:alert(1)")).toBeNull();
  });
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

  it("blocks affiliate and ad network hosts", () => {
    expect(isAdSearchResultUrl("https://awin1.com/cread.php?awinmid=1")).toBe(true);
    expect(isAdSearchResultUrl("https://ads.linkedin.com/click?id=1")).toBe(true);
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

describe("normalizeDomain", () => {
  it("lowercases and strips scheme and wildcard prefixes", () => {
    expect(normalizeDomain("https://Docs.Python.ORG")).toBe("docs.python.org");
    expect(normalizeDomain("*.example.com")).toBe("example.com");
    expect(normalizeDomain("  github.com  ")).toBe("github.com");
  });

  it("converts Unicode homographs to punycode", () => {
    // "аррӏе" uses Cyrillic look-alikes; hostname normalizes to xn-- punycode.
    const result = normalizeDomain("аррӏе.com");
    expect(result).toMatch(/^xn--/);
    expect(result).not.toBe("apple.com");
  });

  it("returns null for un-parseable input", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
  });
});

describe("createWebSearchTool", () => {
  it("does not use a search response after its engine is removed from the allowlist", async () => {
    let allow: readonly string[] = ["html.duckduckgo.com"];
    let bodyStarted: (() => void) | undefined;
    let deliver: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              bodyStarted?.();
              await release;
              controller.enqueue(
                new TextEncoder().encode(
                  '<a class="result__a" href="https://example.com">Secret search result</a>',
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const pending = createWebSearchTool(() => ({ mode: "allowlist", allow })).execute(
      { query: "secret search", max_results: 5 },
      context(),
    );
    await started;
    allow = [];
    deliver?.();
    const result = await pending;

    expect(result).not.toContain("Secret search result");
    expect(result).toContain("No search results");
  });

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
        <a href="https://example.com/organic" class="result-header">Organic laptop deals guide</a>
        <p class="snippet-description">Useful organic shopping guidance.</p>
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

    expect(result).toContain("Organic laptop deals guide");
    expect(result).toContain("https://example.com/organic");
    expect(result).toContain("from Brave");
    expect(result).not.toContain("Cheap laptops for sale");
  });

  it("applies time_range and include_domains to the request", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      // Return organic result only on the Google branch.
      if (capturedUrl.includes("google.com")) {
        return new Response(
          `<div class="g"><a href="https://docs.python.org/3/library/asyncio.html"><h3>Python asyncio Docs</h3></a><div class="VwiC3b">Official asyncio documentation.</div></div>`,
          { status: 200 },
        );
      }
      return new Response("<html></html>", { status: 200 });
    }) as typeof fetch;

    const result = await createWebSearchTool().execute(
      {
        query: "asyncio",
        include_domains: ["docs.python.org"],
        time_range: "week",
        max_results: 5,
      },
      context(),
    );

    // Last captured URL is the Google branch with recency + site scoping.
    expect(capturedUrl).toContain("tbs=qdr:w");
    expect(decodeURIComponent(capturedUrl)).toContain("site:docs.python.org");
    expect(result).toContain("Python asyncio Docs");
    expect(result).toContain("past week");
  });

  it("drops results from excluded domains client-side", async () => {
    const html = `
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fw3schools.com%2Ffetch">W3Schools Fetch</a>
      <a class="result__snippet">Tutorial content.</a>
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FAPI%2FFetch_API">Fetch API - MDN</a>
      <a class="result__snippet">MDN reference.</a>
    `;
    globalThis.fetch = vi.fn(async () => new Response(html, { status: 200 })) as typeof fetch;

    const result = await createWebSearchTool().execute(
      { query: "fetch api", exclude_domains: ["w3schools.com"], max_results: 5 },
      context(),
    );

    expect(result).toContain("Fetch API - MDN");
    expect(result).not.toContain("W3Schools");
    expect(result).toContain("-site:w3schools.com");
  });

  it("filters coupon spam for non-commerce queries but keeps it for commerce queries", async () => {
    const html = `
      <a class="result__a" href="https://coupon.example.com/typescript">TypeScript coupon code</a>
      <a class="result__snippet">Exclusive deal and discount code for docs.</a>
      <a class="result__a" href="https://www.typescriptlang.org/docs/">TypeScript Documentation</a>
      <a class="result__snippet">Official TypeScript docs.</a>
    `;
    globalThis.fetch = vi.fn(async () => new Response(html, { status: 200 })) as typeof fetch;

    const docsResult = await createWebSearchTool().execute(
      { query: "typescript docs", max_results: 5 },
      context(),
    );
    expect(docsResult).toContain("TypeScript Documentation");
    expect(docsResult).not.toContain("TypeScript coupon code");
    expect(docsResult).toContain("filtered 1 spam result");

    globalThis.fetch = vi.fn(async () => new Response(html, { status: 200 })) as typeof fetch;
    const commerceResult = await createWebSearchTool().execute(
      { query: "best typescript coupon", max_results: 5 },
      context(),
    );
    expect(commerceResult).toContain("TypeScript coupon code");
  });

  it("collapses duplicate canonical URLs and reports duplicate count", async () => {
    const html = `
      <a class="result__a" href="https://example.com/docs?utm_source=a&b=2&a=1#top">Docs first</a>
      <a class="result__snippet">First snippet.</a>
      <a class="result__a" href="https://example.com/docs?a=1&b=2">Docs duplicate</a>
      <a class="result__snippet">Duplicate snippet.</a>
    `;
    globalThis.fetch = vi.fn(async () => new Response(html, { status: 200 })) as typeof fetch;

    const result = await createWebSearchTool().execute(
      { query: "example docs", max_results: 5 },
      context(),
    );

    expect(result).toContain("Docs first");
    expect(result).not.toContain("Docs duplicate");
    expect(result).toContain("1 duplicate");
  });

  it("skips sponsored parser blocks and returns organic results", async () => {
    const html = `
      <li class="b_algo b_ad">
        <h2><a href="https://example-ad.com/offer">Sponsored offer</a></h2>
        <div class="b_adlabel">Ad</div><p>Buy now.</p>
      </li>
      <li class="b_algo">
        <h2><a href="https://developer.mozilla.org/docs/Web/API/Fetch_API">Fetch API - MDN</a></h2>
        <div class="b_caption"><p>Useful organic snippet.</p></div>
      </li>
    `;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html></html>", { status: 200 }))
      .mockResolvedValueOnce(new Response("<html></html>", { status: 200 }))
      .mockResolvedValueOnce(new Response("<html></html>", { status: 200 }))
      .mockResolvedValueOnce(new Response(html, { status: 200 })) as typeof fetch;

    const result = await createWebSearchTool().execute(
      { query: "fetch api mdn", max_results: 5 },
      context(),
    );

    expect(result).toContain("Fetch API - MDN");
    expect(result).not.toContain("Sponsored offer");
    expect(result).toContain("from Bing");
  });

  it("reports filtered ad counts only when non-zero", async () => {
    const html = `
      <a class="result__a" href="https://googleadservices.com/pagead/aclk">Cloud hosting</a>
      <a class="result__snippet">Fast platform overview.</a>
      <a class="result__a" href="https://example.com/docs">Docs</a>
      <a class="result__snippet">Organic docs.</a>
    `;
    globalThis.fetch = vi.fn(async () => new Response(html, { status: 200 })) as typeof fetch;

    const filtered = await createWebSearchTool().execute(
      { query: "example docs", max_results: 5 },
      context(),
    );
    expect(filtered).toContain("filtered 1 ad");

    resetWebSearchCache();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          `<a class="result__a" href="https://example.com/docs">Docs</a><a class="result__snippet">Organic docs.</a>`,
          { status: 200 },
        ),
    ) as typeof fetch;
    const clean = await createWebSearchTool().execute(
      { query: "example docs", max_results: 5 },
      context(),
    );
    expect(clean).not.toContain("filtered");
  });

  it("rejects setting both include_domains and exclude_domains via the schema", () => {
    const tool = createWebSearchTool();
    const parsed = tool.parameters.safeParse({
      query: "x",
      include_domains: ["a.com"],
      exclude_domains: ["b.com"],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => /mutually exclusive/i.test(i.message))).toBe(true);
    }
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

  it("coalesces identical in-flight requests and caches successful results", async () => {
    let resolveResponse!: (response: Response) => void;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    globalThis.fetch = vi.fn(() => responsePromise) as typeof fetch;
    const tool = createWebSearchTool();
    const args = { query: "  Example   Docs ", max_results: 5 };

    const first = tool.execute(args, context());
    const second = tool.execute({ ...args, query: "example docs" }, context());
    resolveResponse(
      new Response(
        `<a class="result__a" href="https://example.com/docs">Example Docs</a><a class="result__snippet">Documentation.</a>`,
        { status: 200 },
      ),
    );

    expect(await first).toContain("Example Docs");
    expect(await second).toContain("Example Docs");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    await tool.execute(args, context());
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("separates cache entries by limits and filters and expires them after 60 seconds", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          `<a class="result__a" href="https://example.com/docs">Example Docs</a><a class="result__snippet">Documentation.</a>`,
          { status: 200 },
        ),
    ) as typeof fetch;
    const tool = createWebSearchTool();

    await tool.execute({ query: "example docs", max_results: 5 }, context());
    await tool.execute({ query: "example docs", max_results: 6 }, context());
    await tool.execute(
      { query: "example docs", max_results: 5, include_domains: ["example.com"] },
      context(),
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);

    now += 60_001;
    await tool.execute({ query: "example docs", max_results: 5 }, context());
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it("bounds failed engine retries before falling back", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(
        new Response(
          `<a class="result__a" href="https://example.com/docs">Example Docs</a><a class="result__snippet">Documentation.</a>`,
          { status: 200 },
        ),
      ) as typeof fetch;

    const result = await createWebSearchTool().execute(
      { query: "example docs", max_results: 5 },
      context(),
    );

    expect(result).toContain("Example Docs");
    expect(result).toContain("DuckDuckGoLite");
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});

describe("search page parsers", () => {
  it("uses DOM selectors for structurally nested results", () => {
    const results = parseSearchResults(
      "Bing",
      `<li class="b_algo"><h2><a href="https://example.com/guide"><span>Example Guide</span></a></h2><div class="b_caption"><p>Nested snippet.</p></div></li>`,
    );

    expect(results).toEqual([
      { title: "Example Guide", url: "https://example.com/guide", snippet: "Nested snippet." },
    ]);
  });

  it("retains the regex fallback for legacy provider markup", () => {
    const results = parseSearchResults(
      "DuckDuckGo",
      `<div class="result"><a class="result__title" href="https://example.com/legacy">Legacy Result</a><a class="result__snippet">Legacy snippet.</a></div>`,
    );

    expect(results).toEqual([
      { title: "Legacy Result", url: "https://example.com/legacy", snippet: "Legacy snippet." },
    ]);
  });
});
