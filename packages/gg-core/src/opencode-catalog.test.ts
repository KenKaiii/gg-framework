import { describe, expect, it } from "vitest";
import { parseOpenCodeCatalog } from "./opencode-catalog.js";

/** Rows trimmed from the live `/v1/models` answers (2026-11-11). */
const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "kimi-k3.1-pro",
  name: "Kimi K3.1 Pro",
  type: "chat",
  modalities: { input: ["text", "image/jpeg", "image/png"], output: ["text"] },
  capabilities: {
    tools: { supported: true },
    reasoning: {
      supported: true,
      default: { type: "effort", value: "max" },
      effort: ["low", "high", "max"],
    },
  },
  limit: { context: 1_048_576, output: 131_072 },
  cost: { text: { input: { price: 2 }, output: { price: 10 } } },
  api: { "chat-completions": { base_url: "https://opencode.ai/inference/go/openai/v1" } },
  ...over,
});

describe("parseOpenCodeCatalog", () => {
  it("maps a Go row to a plan-prefixed registry model", () => {
    const { models, skipped } = parseOpenCodeCatalog("opencode-go", { data: [row({})] });
    expect(skipped).toBe(0);
    expect(models).toEqual([
      {
        id: "opencode-go/kimi-k3.1-pro",
        name: "Kimi K3.1 Pro",
        provider: "opencode-go",
        contextWindow: 1_048_576,
        maxOutputTokens: 131_072,
        supportsThinking: true,
        supportsImages: true,
        supportsVideo: false,
        costTier: "medium",
        maxThinkingLevel: "max",
        thinkingLevels: ["low", "high", "max"],
        defaultThinkingLevel: "max",
      },
    ]);
  });

  it("registers a model without an effort ladder as non-thinking", () => {
    const { models } = parseOpenCodeCatalog("opencode-go", {
      data: [
        row({
          id: "mimo-v2.6-pro",
          capabilities: { tools: { supported: true }, reasoning: { supported: true } },
        }),
        row({
          id: "hy4",
          capabilities: {
            tools: { supported: true },
            reasoning: { supported: true, effort: ["none", "high"] },
          },
        }),
      ],
    });
    expect(models[0]).toMatchObject({ supportsThinking: false, maxThinkingLevel: "low" });
    expect(models[0]).not.toHaveProperty("thinkingLevels");
    // `none` is not a level GG Coder sends; thinking off already covers it.
    expect(models[1]).toMatchObject({ supportsThinking: true, thinkingLevels: ["high"] });
  });

  it("caps output at half the window and reads text-only input", () => {
    const { models } = parseOpenCodeCatalog("opencode", {
      data: [
        row({
          id: "grok-4.7",
          modalities: { input: ["text"] },
          limit: { context: 500_000, output: 500_000 },
        }),
      ],
    });
    expect(models[0]).toMatchObject({ maxOutputTokens: 250_000, supportsImages: false });
  });

  it("drops the free tier on pay-as-you-go but keeps it on Go", () => {
    const free = row({ id: "beam-free", cost: { text: { input: { price: 0 } } } });
    expect(parseOpenCodeCatalog("opencode", { data: [free] })).toEqual({ models: [], skipped: 1 });
    expect(parseOpenCodeCatalog("opencode-go", { data: [free] }).models.map((m) => m.id)).toEqual([
      "opencode-go/beam-free",
    ]);
  });

  it("skips rows that can't drive the agent or are malformed", () => {
    const { models, skipped } = parseOpenCodeCatalog("opencode-go", {
      data: [
        row({ id: "image-model", type: "image" }),
        row({ id: "no-tools", capabilities: { tools: { supported: false } } }),
        // Served on another API only: gg-ai would send it to the wrong endpoint.
        row({ id: "gpt-6-luna", api: { responses: {} } }),
        row({ id: "claude-haiku-5-5", api: { messages: {} } }),
        row({ id: "no-api", api: undefined }),
        row({ id: "no-window", limit: {} }),
        row({ id: "bad id/with slash" }),
        row({ id: "kimi-k3" }),
        row({ id: "kimi-k3" }),
        null,
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["opencode-go/kimi-k3"]);
    expect(skipped).toBe(9);
  });

  it("answers an empty list for a body that isn't a model list", () => {
    expect(parseOpenCodeCatalog("opencode", { error: "nope" })).toEqual({ models: [], skipped: 0 });
    expect(parseOpenCodeCatalog("opencode", null)).toEqual({ models: [], skipped: 0 });
  });
});
