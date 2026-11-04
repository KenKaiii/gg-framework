import { afterEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "../agent";
import { openExternal, safeExternalUrl, URL_MAX } from "./safeUrl";

vi.mock("../agent", () => ({ openUrl: vi.fn(async () => {}) }));

afterEach(() => vi.clearAllMocks());

describe("safeExternalUrl", () => {
  it("keeps plain web pages, in the URL parser's own form", () => {
    const cases: [string, string][] = [
      ["https://en.wikipedia.org/wiki/Heat_pump", "https://en.wikipedia.org/wiki/Heat_pump"],
      ["http://example.com", "http://example.com/"],
      ["HTTPS://Example.COM/Path?q=1#top", "https://example.com/Path?q=1#top"],
      ["https://example.com:8443/x", "https://example.com:8443/x"],
      ["https://xn--caf-dma.example/", "https://xn--caf-dma.example/"],
      ["https://café.example/", "https://xn--caf-dma.example/"],
      ["https://arxiv.org/pdf/2401.00001", "https://arxiv.org/pdf/2401.00001"],
    ];
    for (const [raw, want] of cases) expect(safeExternalUrl(raw), raw).toBe(want);
  });

  it("refuses every other scheme, and anything the parser would have to guess at", () => {
    for (const raw of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:image/png;base64,iVBORw0KGgo=",
      "file:///etc/passwd",
      "blob:https://example.com/0b1c2d3e",
      "mailto:someone@example.com",
      "tel:+441234567890",
      "sms:+441234567890",
      "ftp://example.com/file.pdf",
      "ws://example.com/socket",
      "kleio://open",
      "x-apple.systempreferences:com.apple.preference.security",
      "vscode://file/etc/passwd",
      "about:blank",
      "//evil.example/page",
      "/relative/path",
      "relative/path",
      "#top",
      "https://user:secret@example.com/",
      "https://user@example.com/",
      "https://:secret@example.com/",
      "https://exa mple.com/",
      "https://example.com/a b",
      "https://example.com/\u0000",
      "https://example.com/\u0085",
      "https:",
      "https://",
      "http://[::1",
      "",
    ]) {
      expect(safeExternalUrl(raw), JSON.stringify(raw)).toBeNull();
    }
    for (const notText of [
      null,
      undefined,
      42,
      {},
      ["https://example.com"],
      new URL("https://x.y"),
    ]) {
      expect(safeExternalUrl(notText)).toBeNull();
    }
  });

  it("refuses an address over 2,048 characters, before or after parsing", () => {
    const at = (n: number): string => `https://example.com/${"a".repeat(n - 20)}`;
    expect(at(URL_MAX)).toHaveLength(URL_MAX);
    expect(safeExternalUrl(at(URL_MAX))).toBe(at(URL_MAX));
    expect(safeExternalUrl(at(URL_MAX + 1))).toBeNull();
    // Short as written, longer once the parser encodes it.
    const grows = `https://example.com/${"é".repeat(1000)}`;
    expect(grows.length).toBeLessThan(URL_MAX);
    expect(safeExternalUrl(grows)).toBeNull();
  });
});

describe("openExternal", () => {
  it("hands only http and https pages to the browser", () => {
    expect(openExternal("https://example.com/page")).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/page");
    for (const raw of ["javascript:alert(1)", "file:///etc/passwd", "kleio://x", "//x.y", 7]) {
      expect(openExternal(raw)).toBe(false);
    }
    expect(openUrl).toHaveBeenCalledTimes(1);
  });
});
