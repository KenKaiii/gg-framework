import { describe, expect, it, vi } from "vitest";
import {
  SlashCommandRegistry,
  createBuiltinCommands,
  type SlashCommandContext,
} from "./slash-commands.js";

function registry() {
  const reg = new SlashCommandRegistry();
  for (const cmd of createBuiltinCommands()) reg.register(cmd);
  return reg;
}

function context(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    switchModel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => ""),
    getSettings: vi.fn(() => ({})),
    setSetting: vi.fn(async () => {}),
    getModelList: vi.fn(() => ""),
    quit: vi.fn(),
    branch: vi.fn(async () => ""),
    listBranches: vi.fn(async () => ""),
    addDirectory: vi.fn(async (dir: string) => ({ ok: true as const, root: `/resolved${dir}` })),
    removeDirectory: vi.fn(async (dir: string) => ({ ok: true as const, root: `/resolved${dir}` })),
    getAdditionalRoots: vi.fn(() => []),
    ...overrides,
  };
}

describe("/remove-dir", () => {
  it("requires a current root when no path is supplied", async () => {
    await expect(registry().execute("/remove-dir", context())).resolves.toContain(
      "No additional roots",
    );
  });

  it("removes the selected root", async () => {
    const ctx = context();
    await expect(registry().execute("/remove-dir ../sdk", ctx)).resolves.toBe(
      "Removed workspace root: /resolved../sdk",
    );
    expect(ctx.removeDirectory).toHaveBeenCalledWith("../sdk");
  });
});

describe("/add-dir", () => {
  it("lists nothing when no roots were added", async () => {
    await expect(registry().execute("/add-dir", context())).resolves.toContain(
      "No additional roots",
    );
  });

  it("lists current roots", async () => {
    const ctx = context({ getAdditionalRoots: () => ["/a/sdk", "/b/docs"] });
    const out = await registry().execute("/add-dir", ctx);
    expect(out).toContain("/a/sdk");
    expect(out).toContain("/b/docs");
  });

  it("adds a root through the alias too", async () => {
    const ctx = context();
    await expect(registry().execute("/adddir ../sdk", ctx)).resolves.toBe(
      "Added workspace root: /resolved../sdk",
    );
    expect(ctx.addDirectory).toHaveBeenCalledWith("../sdk");
  });

  it("surfaces the rejection reason", async () => {
    const ctx = context({
      addDirectory: async () => ({ ok: false as const, error: "Not a directory: /x" }),
    });
    await expect(registry().execute("/add-dir /x", ctx)).resolves.toBe("Not a directory: /x");
  });
});

describe("/compact focus", () => {
  it("threads /compact <focus> text through to compact()", async () => {
    const reg = registry();
    const compact = vi.fn(async () => {});
    const ctx = context({ compact });
    const out = await reg.execute("/compact payment-refactor deadlines", ctx);
    expect(compact).toHaveBeenCalledWith("payment-refactor deadlines");
    expect(out).toContain("payment-refactor deadlines");
  });

  it("bare /compact passes no focus", async () => {
    const reg = registry();
    const compact = vi.fn(async () => {});
    const ctx = context({ compact });
    const out = await reg.execute("/compact", ctx);
    expect(compact).toHaveBeenCalledWith(undefined);
    expect(out).not.toContain("focus");
  });
});
