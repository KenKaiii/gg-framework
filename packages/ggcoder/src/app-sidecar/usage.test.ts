import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GgCore from "@kenkaiiii/gg-core";
import type { AuthStorage } from "../core/auth-storage.js";
import { createUsageService } from "./usage.js";

const core = vi.hoisted(() => ({ readClaudeCodeUsage: vi.fn(), fetchSubscriptionUsage: vi.fn() }));
vi.mock("@kenkaiiii/gg-core", async (importOriginal) => ({
  ...(await importOriginal<typeof GgCore>()),
  readClaudeCodeUsage: core.readClaudeCodeUsage,
  fetchSubscriptionUsage: core.fetchSubscriptionUsage,
}));

function auth(claudeCode: boolean): AuthStorage {
  return {
    hasClaudeCodeLogin: async () => claudeCode,
    hasProviderAuth: async () => true,
    resolveCredentials: async () => ({ accessToken: "sk-ant-api03-k" }),
  } as unknown as AuthStorage;
}

beforeEach(() => {
  core.readClaudeCodeUsage.mockReset();
  core.fetchSubscriptionUsage.mockReset();
});

describe("Claude subscription usage", () => {
  it("shows the windows Claude Code last reported, without calling a usage endpoint", async () => {
    const windows = [{ kind: "weekly", label: "Weekly", usedPercent: 11, resetsAt: 9e12 }];
    core.readClaudeCodeUsage.mockResolvedValue({
      provider: "anthropic",
      displayName: "Anthropic",
      windows,
      fetchedAt: 5,
    });
    const result = await createUsageService(auth(true)).subscriptionUsage("anthropic");
    expect(result).toMatchObject({ provider: "anthropic", connected: true, windows });
    expect(core.fetchSubscriptionUsage).not.toHaveBeenCalled();
  });

  it("is connected with no windows before Claude Code has reported any", async () => {
    core.readClaudeCodeUsage.mockResolvedValue(null);
    const result = await createUsageService(auth(true)).subscriptionUsage("anthropic");
    expect(result).toMatchObject({ connected: true, windows: [] });
    expect(result.error).toBeUndefined();
  });

  it("has no subscription meter for an Anthropic API key", async () => {
    const result = await createUsageService(auth(false)).subscriptionUsage("anthropic");
    expect(result).toMatchObject({ connected: false, windows: [] });
    expect(core.readClaudeCodeUsage).not.toHaveBeenCalled();
    expect(core.fetchSubscriptionUsage).not.toHaveBeenCalled();
  });
});
