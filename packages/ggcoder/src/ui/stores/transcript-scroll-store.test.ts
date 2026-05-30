import { beforeEach, describe, expect, it } from "vitest";
import {
  getTranscriptScrollOffset,
  pageTranscriptScroll,
  resetTranscriptScroll,
  scrollTranscriptByLines,
  scrollTranscriptToTop,
  setTranscriptScrollBounds,
  setTranscriptScrollOffset,
} from "./transcript-scroll-store.js";

// The store is a module singleton; reset bounds + offset before each test.
beforeEach(() => {
  setTranscriptScrollBounds(0);
  resetTranscriptScroll();
});

describe("transcript-scroll-store", () => {
  it("starts pinned to the bottom", () => {
    expect(getTranscriptScrollOffset()).toBe(0);
  });

  it("scrolls up by a positive delta within bounds", () => {
    setTranscriptScrollBounds(90);
    scrollTranscriptByLines(3);
    expect(getTranscriptScrollOffset()).toBe(3);
  });

  it("scrolls down toward the newest and clamps at 0", () => {
    setTranscriptScrollBounds(90);
    scrollTranscriptByLines(5);
    scrollTranscriptByLines(-2);
    expect(getTranscriptScrollOffset()).toBe(3);
    scrollTranscriptByLines(-100);
    expect(getTranscriptScrollOffset()).toBe(0);
  });

  it("clamps scroll-up to the maximum offset", () => {
    setTranscriptScrollBounds(90);
    scrollTranscriptByLines(9999);
    expect(getTranscriptScrollOffset()).toBe(90);
  });

  it("pages relative to the current offset", () => {
    setTranscriptScrollBounds(90);
    pageTranscriptScroll(20);
    expect(getTranscriptScrollOffset()).toBe(20);
    pageTranscriptScroll(-5);
    expect(getTranscriptScrollOffset()).toBe(15);
  });

  it("jumps to the top (max offset) and to the bottom (0)", () => {
    setTranscriptScrollBounds(90);
    scrollTranscriptToTop();
    expect(getTranscriptScrollOffset()).toBe(90);
    setTranscriptScrollOffset(0);
    expect(getTranscriptScrollOffset()).toBe(0);
  });

  it("re-pins to the bottom on reset", () => {
    setTranscriptScrollBounds(90);
    scrollTranscriptByLines(40);
    resetTranscriptScroll();
    expect(getTranscriptScrollOffset()).toBe(0);
  });

  it("re-clamps the offset when bounds shrink while the user is scrolled", () => {
    setTranscriptScrollBounds(90);
    scrollTranscriptByLines(80);
    expect(getTranscriptScrollOffset()).toBe(80);
    // Content shrinks (e.g. compaction) — offset must clamp into the new range.
    setTranscriptScrollBounds(50);
    expect(getTranscriptScrollOffset()).toBe(50);
  });

  it("keeps the user pinned to the bottom as content grows when not scrolled", () => {
    setTranscriptScrollBounds(10);
    expect(getTranscriptScrollOffset()).toBe(0);
    // New output arrives; an un-scrolled user stays at the bottom.
    setTranscriptScrollBounds(40);
    expect(getTranscriptScrollOffset()).toBe(0);
  });

  it("treats a no-op scroll at an edge without moving the offset", () => {
    setTranscriptScrollBounds(0);
    scrollTranscriptByLines(5);
    expect(getTranscriptScrollOffset()).toBe(0);
    scrollTranscriptByLines(-5);
    expect(getTranscriptScrollOffset()).toBe(0);
  });
});
