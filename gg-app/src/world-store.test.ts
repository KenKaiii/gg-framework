// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isWorldKey, readWorldStore, writeWorldStore } from "./world-store";

afterEach(() => localStorage.clear());

describe("world-store", () => {
  it("hands World only its own keys, never the app's", () => {
    localStorage.setItem("night-rooms-look", '{"hair":"#111"}');
    localStorage.setItem("gg-pool-wins", "3");
    localStorage.setItem("gg-notes:/Users/me/secret-project", "my private notes");
    localStorage.setItem("gg-world-save-consent", '{"v":1,"on":true}');
    expect(readWorldStore()).toEqual({
      "night-rooms-look": '{"hair":"#111"}',
      "gg-pool-wins": "3",
    });
  });

  it("only writes World's keys", () => {
    localStorage.setItem("gg-notes:/a", "keep me");
    writeWorldStore({
      "tavern-best": "9",
      "gg-notes:/a": "overwritten?",
      "gg-tools-hidden": "x",
      "fc-x": null,
    });
    expect(localStorage.getItem("tavern-best")).toBe("9");
    expect(localStorage.getItem("gg-notes:/a")).toBe("keep me");
    expect(localStorage.getItem("gg-tools-hidden")).toBeNull();
    localStorage.setItem("fc-x", "1");
    writeWorldStore({ "fc-x": null });
    expect(localStorage.getItem("fc-x")).toBeNull();
  });

  it("ignores junk", () => {
    writeWorldStore(null);
    writeWorldStore(["night-rooms-a"]);
    writeWorldStore({ "night-rooms-a": 5 });
    expect(localStorage.length).toBe(0);
    expect(isWorldKey("night-rooms-" + "x".repeat(200))).toBe(false);
  });
});
