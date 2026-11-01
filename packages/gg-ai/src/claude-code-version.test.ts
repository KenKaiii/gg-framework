import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gg-ccv-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeCache(version: string, fetchedAt: number) {
  fs.mkdirSync(path.join(home, ".gg"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".gg", "claude-code-version.json"),
    JSON.stringify({ version, fetchedAt }),
  );
}

function stubNpm(version: string) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getClaudeCodeVersion", () => {
  it("serves a fresh disk cache without touching npm", async () => {
    writeCache("2.1.900", Date.now());
    const fetchMock = stubNpm("9.9.9");
    const mod = await import("./claude-code-version.js");
    expect(await mod.getClaudeCodeVersion()).toBe("2.1.900");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves a stale disk cache at once and refreshes it in the background", async () => {
    writeCache("2.1.900", Date.now() - 3 * 24 * 60 * 60 * 1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ version: "2.1.950" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("./claude-code-version.js");

    // Returns before the (blocked) npm request completes.
    expect(await mod.getClaudeCodeVersion()).toBe("2.1.900");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release();
    await mod.pendingClaudeCodeVersionRefresh();
    expect(await mod.getClaudeCodeVersion()).toBe("2.1.950");
    const disk = JSON.parse(
      fs.readFileSync(path.join(home, ".gg", "claude-code-version.json"), "utf8"),
    );
    expect(disk.version).toBe("2.1.950");
  });

  it("waits for npm when there is no disk cache", async () => {
    stubNpm("2.1.401");
    const mod = await import("./claude-code-version.js");
    expect(await mod.getClaudeCodeVersion()).toBe("2.1.401");
  });

  it("falls back to the built-in version when npm fails and nothing is cached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const mod = await import("./claude-code-version.js");
    expect(await mod.getClaudeCodeVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("Claude Code version floor (issue #126)", () => {
  it("keeps the built-in fallback at or above Anthropic's 2.1.280 minimum", async () => {
    const { CLAUDE_CODE_FALLBACK_VERSION } = await import("./claude-code-version.js");
    const [major = 0, minor = 0, patch = 0] = CLAUDE_CODE_FALLBACK_VERSION.split(".").map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(2_001_280);
  });

  it("never serves a cached version older than the fallback", async () => {
    writeCache("2.1.75", Date.now());
    const fetchMock = stubNpm("9.9.9");
    const mod = await import("./claude-code-version.js");
    expect(await mod.getClaudeCodeVersion()).toBe(mod.CLAUDE_CODE_FALLBACK_VERSION);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
