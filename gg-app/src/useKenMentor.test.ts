// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useKenMentor } from "./useKenMentor";
import type { Item } from "./App";
import type { SidecarEvent } from "./agent";

/**
 * Drive the hook with a real (mutable) items array + monotonic id minter, mirroring
 * how App wires it. setItems runs synchronously here, so transcript appends are
 * observable immediately; the hook's own React state (kenRunning, kenTokens, …) is
 * read off result.current after an act() flush.
 */
function setup() {
  let items: Item[] = [];
  let id = 0;
  const setItems = (u: Item[] | ((prev: Item[]) => Item[])): void => {
    items = typeof u === "function" ? u(items) : u;
  };
  const nextId = (): number => ++id;
  const hook = renderHook(() => useKenMentor({ setItems, nextId }));
  return { hook, getItems: () => items };
}

const ev = (type: string, data: Record<string, unknown> = {}): SidecarEvent =>
  ({ type, data }) as SidecarEvent;

describe("useKenMentor", () => {
  it("ken_text_delta appends a single kind:'ken' item via setItems", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_text_delta", { text: "hello" }));
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "ken", text: "hello" });

    // A second delta appends to the SAME bubble, not a new item.
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_text_delta", { text: " world" }));
    });
    const after = getItems();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: "ken", text: "hello world" });
  });

  it("ken_run_start flips kenRunning true and resets tokens", () => {
    const { hook } = setup();
    // Seed some tokens first so the reset is observable.
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_turn_end", { usage: { outputTokens: 42 } }));
    });
    expect(hook.result.current.kenTokens).toBe(42);

    act(() => {
      hook.result.current.handleKenEvent(ev("ken_run_start"));
    });
    expect(hook.result.current.kenRunning).toBe(true);
    expect(hook.result.current.kenTokens).toBe(0);
    expect(hook.result.current.kenRunStartTs).toBeTypeOf("number");
  });

  it("ken_turn_end accumulates outputTokens across turns", () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_run_start"));
    });
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_turn_end", { usage: { outputTokens: 10 } }));
    });
    expect(hook.result.current.kenTokens).toBe(10);
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_turn_end", { usage: { outputTokens: 5 } }));
    });
    expect(hook.result.current.kenTokens).toBe(15);
  });

  it("ken_error with only a message (legacy shape) falls back to a flat text item", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_run_start"));
    });
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_error", { message: "boom" }));
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "error" });
    expect((items[0] as { text: string }).text).toContain("boom");
    expect(hook.result.current.kenRunning).toBe(false);
  });

  it("ken_error with a structured payload prefixes the headline with Supah", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleKenEvent(ev("ken_run_start"));
    });
    act(() => {
      hook.result.current.handleKenEvent(
        ev("ken_error", {
          headline: "Anthropic usage limit reached.",
          message: "Your Anthropic usage is finished. It resets at 12:50 PM.",
          guidance: "Try again once it's back. Your conversation is preserved.",
        }),
      );
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "error",
      headline: "Supah: Anthropic usage limit reached.",
      message: "Your Anthropic usage is finished. It resets at 12:50 PM.",
      guidance: "Try again once it's back. Your conversation is preserved.",
    });
    expect(hook.result.current.kenRunning).toBe(false);
  });

  it("returns true for ken events and false for a non-ken event", () => {
    const { hook, getItems } = setup();
    let kenHandled = false;
    let buildHandled = true;
    act(() => {
      kenHandled = hook.result.current.handleKenEvent(ev("ken_run_start"));
      buildHandled = hook.result.current.handleKenEvent(ev("text_delta", { text: "build" }));
    });
    expect(kenHandled).toBe(true);
    expect(buildHandled).toBe(false);
    // A non-ken event must NOT have touched the transcript.
    expect(getItems()).toHaveLength(0);
  });
});
