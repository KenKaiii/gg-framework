import { describe, expect, it } from "vitest";
import { getContextWindow, MODELS } from "../model-registry.js";
import {
  DEFAULT_COMPACTION_THRESHOLD,
  resolveCompactionPolicy,
  resolveLatencyWindowCap,
} from "./policy.js";
import { shouldCompact } from "./compactor.js";

describe("resolveCompactionPolicy", () => {
  it("uses the shared 0.85 default and exact whole-token trigger", () => {
    const policy = resolveCompactionPolicy({
      provider: "anthropic",
      model: "claude-test",
      contextWindow: 200_000,
    });

    expect(policy.threshold).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect(policy.targetTokens).toBe(170_000);
  });

  it("keys retries by transport, model, threshold, and approved plan", () => {
    const api = resolveCompactionPolicy({
      provider: "openai",
      model: "gpt-5.5",
      contextWindow: 1_050_000,
      threshold: 0.8,
    });
    const codex = resolveCompactionPolicy({
      provider: "openai",
      model: "gpt-5.5",
      contextWindow: 272_000,
      threshold: 0.8,
      accountId: "account",
      approvedPlanPath: "/tmp/plan.md",
    });

    // Both routes land on 0.8 × 272K: the API key's 1.05M window is capped at
    // OpenAI's 272K price line, the Codex route already passes 272K.
    expect(api.targetTokens).toBe(217_600);
    expect(codex.targetTokens).toBe(217_600);
    expect(codex.policyKey).not.toBe(api.policyKey);
    expect(codex.policyKey).toContain("codex_oauth");
    expect(codex.policyKey).toContain("/tmp/plan.md");
  });

  it("caps GLM's trigger window on a latency budget despite the 1M advertised window", () => {
    // Regression shape of the 2026-09-22 incident: a GLM session at 213K
    // tokens (21% of a 1M window) paid 44-68s TTFT on every turn and never
    // triggered the 85% compaction (limit: 850K). The latency cap must pull
    // the trigger down to ~150K so long-looping sessions summarize long
    // before every turn costs a minute of prefill.
    expect(resolveLatencyWindowCap("glm")).toBe(176_000);

    const policy = resolveCompactionPolicy({
      provider: "glm",
      model: "glm-5.3",
      contextWindow: 1_000_000,
    });
    expect(policy.targetTokens).toBe(149_600); // 0.85 × 176K latency cap
    expect(policy.policyKey).toContain('"contextWindow":176000');
  });

  it("keeps a smaller advertised window authoritative over the latency cap", () => {
    const policy = resolveCompactionPolicy({
      provider: "glm",
      model: "glm-future-lite",
      contextWindow: 120_000,
    });
    expect(policy.targetTokens).toBe(102_000); // 0.85 × 120K — cap is a max, not a floor
  });

  it("applies the latency cap through the user-configured threshold", () => {
    const policy = resolveCompactionPolicy({
      provider: "glm",
      model: "glm-5.3",
      contextWindow: 1_000_000,
      threshold: 0.5,
    });
    expect(policy.targetTokens).toBe(88_000); // 0.5 × 176K
  });

  it("leaves providers with evidence of healthy caching on the advertised window", () => {
    for (const provider of ["anthropic", "deepseek", "moonshot", "openrouter"] as const) {
      expect(resolveLatencyWindowCap(provider), provider).toBeUndefined();
    }
    const policy = resolveCompactionPolicy({
      provider: "anthropic",
      model: "claude-test",
      contextWindow: 200_000,
      threshold: 0.8,
    });
    expect(policy.targetTokens).toBe(160_000);
  });

  it("applies the conservative default cap only to providers with no evidence", () => {
    for (const provider of ["sakana", "huggingface"] as const) {
      expect(resolveLatencyWindowCap(provider), provider).toBe(400_000);
    }
    const policy = resolveCompactionPolicy({
      provider: "sakana",
      model: "fugu",
      contextWindow: 1_000_000,
    });
    expect(policy.targetTokens).toBe(340_000); // 0.85 × 400K default cap
  });

  it("caps where evidence says to: input limits, price tiers, the vendor's own agent", () => {
    // MiniMax-M3 doubles its price past 512K input.
    expect(
      resolveCompactionPolicy({
        provider: "minimax",
        model: "MiniMax-M3",
        contextWindow: 1_000_000,
      }).targetTokens,
    ).toBe(400_000); // price-line cap 435.2K, then the 400K default trigger
    // Gemini CLI compresses at 50% of 1,048,576 on the same Code Assist route.
    expect(
      resolveCompactionPolicy({
        provider: "gemini",
        model: "gemini-3.8-flash",
        contextWindow: 1_048_576,
      }).targetTokens,
    ).toBe(400_000); // Gemini CLI line 523.6K, then the 400K default trigger
    // Price lines that reprice the whole request: Grok at 200K, GPT-6 at 272K.
    expect(
      resolveCompactionPolicy({ provider: "xai", model: "grok-4.7", contextWindow: 500_000 })
        .targetTokens,
    ).toBe(170_000);
    expect(
      resolveCompactionPolicy({
        provider: "openai",
        model: "gpt-6.1-sol",
        contextWindow: 1_050_000,
      }).targetTokens,
    ).toBe(231_200);
    // Gemini 3.1 Pro's own price line (200K) wins over the provider's 616K cap.
    expect(
      resolveCompactionPolicy({
        provider: "gemini",
        model: "gemini-3.1-pro-preview",
        contextWindow: 1_048_576,
      }).targetTokens,
    ).toBe(170_000);
    // MiMo: measured TTFT cliff past 200K (12.5s vs 7.3s at 150–200K).
    expect(
      resolveCompactionPolicy({
        provider: "xiaomi",
        model: "mimo-v2.6-pro",
        contextWindow: 1_000_000,
      }).targetTokens,
    ).toBe(170_000);
  });

  it("never raises a trigger the provider's real window keeps lower", () => {
    // A typical 256K window under the 400K default: min() keeps it authoritative.
    const policy = resolveCompactionPolicy({
      provider: "moonshot",
      model: "kimi-k2.7-code",
      contextWindow: 262_144,
      threshold: 0.8,
    });
    expect(policy.targetTokens).toBe(209_716); // 0.8 × 262,144 — unchanged
  });

  it("gives every registered model a trigger inside its window, from a sourced rule", () => {
    // Providers verified to have NO evidence either way. Adding a provider
    // means adding a sourced rule to policy.ts, or listing it here on purpose.
    const unverified = new Set(["sakana", "huggingface"]);
    for (const model of MODELS) {
      const contextWindow = getContextWindow(model.id, { provider: model.provider });
      const { targetTokens } = resolveCompactionPolicy({
        provider: model.provider,
        model: model.id,
        contextWindow,
      });
      expect(targetTokens, model.id).toBeLessThan(contextWindow);
      // Catches a mistyped cap; GLM's measured 176K cap sits at 15% of 1M.
      expect(targetTokens, model.id).toBeGreaterThan(contextWindow * 0.1);
      if (!unverified.has(model.provider)) {
        expect(
          resolveLatencyWindowCap(model.provider),
          `${model.provider} has a sourced rule`,
        ).not.toBe(400_000);
      }
    }
  });
});

describe("compactAtTokens", () => {
  const base = { provider: "anthropic" as const, model: "claude-x", contextWindow: 1_000_000 };

  it("unset uses the 400K default trigger", () => {
    const a = resolveCompactionPolicy(base);
    const b = resolveCompactionPolicy({ ...base, compactAtTokens: undefined });
    expect(a.targetTokens).toBe(400_000);
    expect(b).toEqual(a);
  });

  it("caps the trigger and fires exactly at the absolute target", () => {
    const policy = resolveCompactionPolicy({ ...base, compactAtTokens: 400_000 });
    expect(policy.targetTokens).toBe(400_000);
    expect(policy.policyKey).toContain("compactAtTokens");
    const msgs = [{ role: "user" as const, content: "x" }];
    expect(shouldCompact(msgs, 1_000_000, policy.threshold, 399_999, policy.targetTokens)).toBe(
      false,
    );
    expect(shouldCompact(msgs, 1_000_000, policy.threshold, 400_000, policy.targetTokens)).toBe(
      true,
    );
  });

  it("never raises a smaller window or provider-cap trigger", () => {
    expect(
      resolveCompactionPolicy({ ...base, contextWindow: 200_000, compactAtTokens: 400_000 })
        .targetTokens,
    ).toBe(170_000);
    expect(
      resolveCompactionPolicy({
        provider: "openai",
        model: "gpt-x",
        contextWindow: 1_050_000,
        compactAtTokens: 500_000,
      }).targetTokens,
    ).toBe(231_200);
  });

  it("a higher setting restores the window-relative trigger", () => {
    expect(resolveCompactionPolicy({ ...base, compactAtTokens: 2_000_000 }).targetTokens).toBe(
      850_000,
    );
  });

  it("ignores non-positive or non-finite values", () => {
    for (const v of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveCompactionPolicy({ ...base, compactAtTokens: v }).targetTokens).toBe(400_000);
    }
  });
});
