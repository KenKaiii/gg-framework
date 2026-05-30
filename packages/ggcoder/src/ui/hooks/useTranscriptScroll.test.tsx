import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, Text } from "ink";
import type * as InkModule from "ink";
import { Writable } from "node:stream";
import type { Key } from "ink";
import { useTranscriptScroll } from "./useTranscriptScroll.js";
import {
  getTranscriptScrollOffset,
  resetTranscriptScroll,
  setTranscriptScrollBounds,
} from "../stores/transcript-scroll-store.js";

const inputHandlers: Array<(input: string, key: Key) => void> = [];

vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<typeof InkModule>();
  return {
    ...actual,
    useInput: (handler: (input: string, key: Key) => void, opts?: { isActive?: boolean }) => {
      if (opts?.isActive !== false) inputHandlers.push(handler);
    },
  };
});

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  } as Key;
}

interface HarnessProps {
  totalLines: number;
  viewportRows: number;
  resetToken: number;
}

function Harness({ totalLines, viewportRows, resetToken }: HarnessProps) {
  useTranscriptScroll({ totalLines, viewportRows, active: true, resetToken });
  return <Text>{getTranscriptScrollOffset()}</Text>;
}

function renderHarness(props: HarnessProps) {
  inputHandlers.length = 0;
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }) as NodeJS.WriteStream;
  stdout.columns = 80;
  stdout.rows = 24;
  const instance = render(<Harness {...props} />, { stdout, patchConsole: false });
  return { instance };
}

async function press(input: string, k: Partial<Key> = {}) {
  inputHandlers.at(-1)?.(input, key(k));
  // Let React flush the state update + commit before assertions read it.
  await new Promise((resolve) => setImmediate(resolve));
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

// The store is a module singleton; reset it before each test.
beforeEach(() => {
  setTranscriptScrollBounds(0);
  resetTranscriptScroll();
});

describe("useTranscriptScroll", () => {
  it("starts stuck to the bottom", async () => {
    renderHarness({ totalLines: 100, viewportRows: 10, resetToken: 0 });
    await flush();
    expect(getTranscriptScrollOffset()).toBe(0);
  });

  it("syncs the store bounds from totalLines and viewportRows", async () => {
    renderHarness({ totalLines: 100, viewportRows: 10, resetToken: 0 });
    await flush();
    // maxOffset = 100 - 10 = 90, so g (top) lands at 90.
    await press("g");
    expect(getTranscriptScrollOffset()).toBe(90);
  });

  it("pages up by viewportRows - 1", async () => {
    renderHarness({ totalLines: 100, viewportRows: 10, resetToken: 0 });
    await flush();
    await press("", { pageUp: true });
    expect(getTranscriptScrollOffset()).toBe(9);
  });

  it("pages down toward the bottom and clamps at 0", async () => {
    renderHarness({ totalLines: 100, viewportRows: 10, resetToken: 0 });
    await flush();
    await press("", { pageUp: true });
    await press("", { pageDown: true });
    expect(getTranscriptScrollOffset()).toBe(0);
  });

  it("scrolls line-by-line with shift+arrows", async () => {
    renderHarness({ totalLines: 100, viewportRows: 10, resetToken: 0 });
    await flush();
    await press("", { shift: true, upArrow: true });
    expect(getTranscriptScrollOffset()).toBe(1);
    await press("", { shift: true, downArrow: true });
    expect(getTranscriptScrollOffset()).toBe(0);
  });

  it("jumps to top with g and bottom with G", async () => {
    renderHarness({ totalLines: 100, viewportRows: 10, resetToken: 0 });
    await flush();
    await press("g");
    expect(getTranscriptScrollOffset()).toBe(90);
    await press("G");
    expect(getTranscriptScrollOffset()).toBe(0);
  });

  it("resets to the bottom when the reset token changes", async () => {
    const { instance } = renderHarness({ totalLines: 100, viewportRows: 10, resetToken: 0 });
    await flush();
    await press("", { pageUp: true });
    expect(getTranscriptScrollOffset()).toBeGreaterThan(0);
    instance.rerender(<Harness totalLines={100} viewportRows={10} resetToken={1} />);
    await flush();
    expect(getTranscriptScrollOffset()).toBe(0);
  });
});
