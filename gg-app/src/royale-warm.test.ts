// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({
  royaleStatus: vi.fn(),
  openRoyale: vi.fn(),
}));
vi.mock("./agent", () => agent);

import { ROYALE_CONSENT_VERSION } from "./RoyaleKey";
import {
  preconnectRoyale,
  resetRoyaleWarm,
  takeWarmRoyaleUrl,
  WARM_MAX_AGE_MS,
  warmRoyale,
} from "./royale-warm";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resetRoyaleWarm();
  localStorage.clear();
  document.head.querySelectorAll('link[rel="preconnect"]').forEach((l) => l.remove());
  agent.royaleStatus.mockResolvedValue({ linked: true, serverUrl: "https://royale.test" });
  agent.openRoyale.mockResolvedValue("https://royale.test/#code=warm");
});
afterEach(() => resetRoyaleWarm());

describe("royale-warm", () => {
  it("never links or fetches a code before this computer agreed to the link box", async () => {
    warmRoyale();
    preconnectRoyale();
    await flush();
    expect(agent.openRoyale).not.toHaveBeenCalled();
    expect(document.head.querySelector('link[rel="preconnect"]')).toBeNull();

    localStorage.setItem("gg-royale-consent", String(ROYALE_CONSENT_VERSION));
    agent.royaleStatus.mockResolvedValue({ linked: false, serverUrl: "https://royale.test" });
    warmRoyale();
    await flush();
    expect(agent.openRoyale).not.toHaveBeenCalled();
  });

  it("connects early, fetches one code, reuses it while fresh and hands it out once", async () => {
    localStorage.setItem("gg-royale-consent", String(ROYALE_CONSENT_VERSION));
    preconnectRoyale();
    await flush();
    const links = document.head.querySelectorAll('link[rel="preconnect"]');
    expect(links).toHaveLength(1);
    expect((links[0] as HTMLLinkElement).href).toBe("https://royale.test/");

    warmRoyale();
    await flush();
    warmRoyale(); // pointing at it again: same code, no new request
    await flush();
    expect(agent.openRoyale).toHaveBeenCalledTimes(1);
    expect(document.head.querySelectorAll('link[rel="preconnect"]')).toHaveLength(1);

    await expect(takeWarmRoyaleUrl()).resolves.toBe("https://royale.test/#code=warm");
    // One-time: the next open asks for its own.
    expect(takeWarmRoyaleUrl()).toBeNull();
  });

  it("drops a code that's too old to trust", async () => {
    localStorage.setItem("gg-royale-consent", String(ROYALE_CONSENT_VERSION));
    warmRoyale();
    await flush();
    expect(takeWarmRoyaleUrl(Date.now() + WARM_MAX_AGE_MS + 1)).toBeNull();
  });

  it("forgets a failed warm-up so the screen asks again", async () => {
    localStorage.setItem("gg-royale-consent", String(ROYALE_CONSENT_VERSION));
    agent.openRoyale.mockRejectedValueOnce(new Error("offline"));
    warmRoyale();
    await flush();
    await flush();
    expect(takeWarmRoyaleUrl()).toBeNull();
  });
});
