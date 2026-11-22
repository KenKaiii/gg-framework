import { describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { BrowserManager, BrowserUnavailableError, type Chromium } from "./browser-session.js";

const missing = (): Promise<never> =>
  Promise.reject(new Error("browserType.launch: Executable doesn't exist at /x/chrome"));
const noChrome = (): Promise<never> =>
  Promise.reject(new Error("Chromium distribution 'chrome' is not found at /Applications"));

function fakeBrowser(): Browser {
  const page = { isClosed: () => false };
  const context = {
    addInitScript: async () => {},
    on: () => {},
    newPage: async () => page,
    pages: () => [page],
  };
  return {
    on: () => {},
    newContext: async () => context,
    close: async () => {},
  } as unknown as Browser;
}

// Launch fails until `installed` is set, like a Playwright upgrade without its Chromium build.
function fakeChromium(state: { installed: boolean; chrome?: boolean }): Chromium {
  return {
    launch: (opts) => {
      if (opts.channel === "chrome")
        return state.chrome ? Promise.resolve(fakeBrowser()) : noChrome();
      return state.installed ? Promise.resolve(fakeBrowser()) : missing();
    },
  };
}

describe("BrowserManager launch without a downloaded browser", () => {
  it("downloads Chromium once, then launches it", async () => {
    const state = { installed: false };
    const installChromium = vi.fn(async () => {
      state.installed = true;
    });
    const manager = new BrowserManager({
      loadChromium: async () => fakeChromium(state),
      installChromium,
    });
    await manager.page();
    expect(installChromium).toHaveBeenCalledTimes(1);
    expect(manager.isOpen).toBe(true);
    expect(manager.events).toContain("Downloaded Chromium for the browser tool (one-time setup).");
  });

  it("uses an installed Chrome without downloading", async () => {
    const installChromium = vi.fn(async () => {});
    const manager = new BrowserManager({
      loadChromium: async () => fakeChromium({ installed: false, chrome: true }),
      installChromium,
    });
    await manager.page();
    expect(installChromium).not.toHaveBeenCalled();
  });

  it("reports a failed download with the manual fix and retries next call", async () => {
    const installChromium = vi.fn(() => Promise.reject(new Error("getaddrinfo ENOTFOUND")));
    const manager = new BrowserManager({
      loadChromium: async () => fakeChromium({ installed: false }),
      installChromium,
    });
    const err = await manager.page().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toMatch(/Could not download Chromium.*ENOTFOUND/);
    expect((err as Error).message).toContain("playwright install chromium");
    await manager.page().catch(() => {});
    expect(installChromium).toHaveBeenCalledTimes(2);
  });

  it("says the download is still running instead of hanging the tool call", async () => {
    const manager = new BrowserManager({
      loadChromium: async () => fakeChromium({ installed: false }),
      installChromium: () => new Promise(() => {}),
      installWaitMs: 10,
    });
    await expect(manager.page()).rejects.toThrow(/still downloading.*Call browser again/);
  });
});
