// @vitest-environment jsdom
import html from "../index.html?raw";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkingBeam } from "./WorkingBeam";

let nonceStyle: HTMLStyleElement;
beforeEach(() => {
  // Production Tauri nonces the initial inline style. unsafe-inline is then
  // ignored, so every runtime effect stylesheet must carry that same nonce.
  nonceStyle = document.createElement("style");
  nonceStyle.id = "app-style-nonce";
  nonceStyle.nonce = "test-window-nonce";
  document.head.appendChild(nonceStyle);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  nonceStyle.remove();
  vi.unstubAllGlobals();
});

it("keeps the nonce source in the actual desktop entry HTML", () => {
  expect(html).toMatch(/<style id="app-style-nonce">/);
});

it("authorizes the real lazy beam styles using the current window nonce", async () => {
  const { container, rerender } = render(<WorkingBeam active />);
  await waitFor(() => expect(container.querySelector("style")?.nonce).toBe(nonceStyle.nonce));
  rerender(<WorkingBeam active size="sm" />);
  expect(container.querySelector("style")?.nonce).toBe(nonceStyle.nonce);
});
