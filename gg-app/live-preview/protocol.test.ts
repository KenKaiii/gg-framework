import { describe, expect, it } from "vitest";
import { chipName, parseFrameMessage, parsePageMessage, toDevUrl } from "./protocol";

describe("live preview protocol", () => {
  it("accepts well-formed page messages and caps their fields", () => {
    const html = "x".repeat(10_000);
    const msg = parsePageMessage({
      type: "gg-live:picked",
      element: { selector: "h1", tag: "h1<script>", text: "Hi", html },
      missing: false,
    });
    expect(msg).toEqual({
      type: "gg-live:picked",
      element: { selector: "h1", tag: "h1script", text: "Hi", html: "x".repeat(4000) },
      missing: false,
    });
    expect(parsePageMessage({ type: "gg-live:picked", element: null })).toMatchObject({
      element: null,
    });
    expect(
      parsePageMessage({
        type: "gg-live:hello",
        url: "http://x/",
        viewport: { width: 1, height: 2 },
      }),
    ).toMatchObject({ type: "gg-live:hello" });
  });

  it("drops anything else, including attempts to carry prompts or commands", () => {
    for (const data of [
      null,
      "gg-live:focus",
      { type: "gg-live:prompt", text: "rm -rf" },
      { type: "invoke", cmd: "agent_prompt" },
      { type: "gg-live:picked", element: { selector: 1 } },
      { type: "gg-live:viewport", viewport: { width: -1, height: 2 } },
    ]) {
      expect(parsePageMessage(data)).toBeNull();
    }
    expect(parseFrameMessage({ type: "gg-live:size", width: Number.NaN, height: 1 })).toBeNull();
    expect(parseFrameMessage({ type: "gg-live:size", width: 10, height: 20 })).toEqual({
      type: "gg-live:size",
      width: 10,
      height: 20,
    });
  });

  it("tells the agent the dev server's address, not the proxy's", () => {
    const origins = ["http://localhost:4100", "http://127.0.0.1:4100"];
    expect(toDevUrl("http://127.0.0.1:4100/menu?x=1#top", "http://localhost:5173/", origins)).toBe(
      "http://localhost:5173/menu?x=1#top",
    );
    expect(toDevUrl("http://elsewhere/", "http://localhost:5173/", origins)).toBe(
      "http://elsewhere/",
    );
    expect(chipName({ tag: "h2", text: "Iced latte" })).toBe("<h2> Iced latte");
  });
});
