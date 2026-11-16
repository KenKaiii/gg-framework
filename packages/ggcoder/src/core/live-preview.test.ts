import { describe, expect, it } from "vitest";
import {
  buildLivePreviewPrompt,
  livePreviewChip,
  parseLivePreviewMeta,
  splitLivePreviewPrompt,
} from "./live-preview.js";

const element = {
  selector: "section.menu > div.card:nth-of-type(3) > h2",
  html: "<h2>Iced latte</h2>",
  tag: "h2",
  text: "Iced latte",
};

describe("live preview prompts", () => {
  it("rejects missing or malformed meta", () => {
    expect(parseLivePreviewMeta(undefined)).toBeNull();
    expect(parseLivePreviewMeta("x")).toBeNull();
    expect(parseLivePreviewMeta({ element })).toBeNull();
  });

  it("keeps a valid element, caps sizes and drops a malformed one", () => {
    const meta = parseLivePreviewMeta({
      url: "http://localhost:5173/",
      element: { ...element, html: "x".repeat(9000) },
    });
    expect(meta?.element?.html).toHaveLength(4000);
    expect(
      parseLivePreviewMeta({ url: "http://localhost:5173/", element: { tag: "h2" } })?.element,
    ).toBeNull();
    expect(
      parseLivePreviewMeta({ url: "u", element: { ...element, tag: 'h2" onload="x' } })?.element
        ?.tag,
    ).toBe("h2onloadx");
  });

  it("gives the agent the element and reply rules, and shows the user only their words and a chip", () => {
    const meta = parseLivePreviewMeta({ url: "http://localhost:5173/", element })!;
    const prompt = buildLivePreviewPrompt("Change to Spanish Latte", meta, "/proj");
    expect(prompt.startsWith("Change to Spanish Latte\n\n<live-preview ")).toBe(true);
    expect(prompt).toContain("<h2>Iced latte</h2>");
    expect(prompt).toContain("Reply in one short sentence");
    expect(splitLivePreviewPrompt(prompt)).toEqual({
      text: "Change to Spanish Latte",
      chip: "<h2> Iced latte",
    });
  });

  it("round-trips a chip with quotes and works without an element", () => {
    const meta = parseLivePreviewMeta({
      url: "u",
      element: { ...element, text: 'Say "hi" & go' },
    })!;
    expect(splitLivePreviewPrompt(buildLivePreviewPrompt("fix", meta, "/p"))?.chip).toBe(
      '<h2> Say "hi" & go',
    );
    expect(
      splitLivePreviewPrompt(
        buildLivePreviewPrompt("why slow?", { url: "u", element: null }, "/p"),
      ),
    ).toEqual({
      text: "why slow?",
      chip: null,
    });
  });

  it("fences HTML that itself contains backticks", () => {
    const meta = parseLivePreviewMeta({
      url: "u",
      element: { ...element, html: "<code>```js</code>" },
    })!;
    expect(buildLivePreviewPrompt("x", meta, "/p")).toContain("````html");
  });

  it("leaves ordinary messages alone", () => {
    expect(splitLivePreviewPrompt("hello")).toBeNull();
    expect(splitLivePreviewPrompt("talk about </live-preview>")).toBeNull();
    expect(livePreviewChip({ tag: "p", text: "" })).toBe("<p>");
  });
});
