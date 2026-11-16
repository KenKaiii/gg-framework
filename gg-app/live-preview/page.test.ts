// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { findPicked, pickedFrom, selectorFor } from "./page";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("live preview picker", () => {
  it("builds a short selector that stops at an id", () => {
    document.body.innerHTML = `<main id="app"><ul class="menu list extra"><li>A</li><li>B</li></ul></main>`;
    const b = document.querySelectorAll("li")[1];
    expect(selectorFor(b)).toBe("main#app > ul.menu.list > li:nth-of-type(2)");
    expect(document.querySelector(selectorFor(b))).toBe(b);
  });

  it("finds the picked element again after a hot update moved it", () => {
    document.body.innerHTML = `<ul><li class="item">Latte</li><li class="item">Mocha</li></ul>`;
    const picked = pickedFrom(document.querySelectorAll("li")[1], "/");
    // A new item above shifts it: same content wins over the old position.
    document.body.innerHTML = `<ul><li class="item">New</li><li class="item">Latte</li><li class="item">Mocha</li></ul>`;
    expect(findPicked(picked, document, "/")?.textContent).toBe("Mocha");
  });

  it("falls back to position when the content itself changed, and not on another route", () => {
    document.body.innerHTML = `<h1 class="t">Hello</h1>`;
    const picked = pickedFrom(document.querySelector("h1")!, "/");
    document.body.innerHTML = `<h1 class="t">Hello there</h1>`;
    expect(findPicked(picked, document, "/")?.textContent).toBe("Hello there");
    expect(findPicked(picked, document, "/other")).toBeNull();
    document.body.innerHTML = `<p>gone</p>`;
    expect(findPicked(picked, document, "/")).toBeNull();
  });
});
