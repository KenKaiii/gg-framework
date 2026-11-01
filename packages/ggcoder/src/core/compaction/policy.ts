import type { Provider } from "@kenkaiiii/gg-ai";

export const DEFAULT_COMPACTION_THRESHOLD = 0.85;

/**
 * Caps on the context window used for compaction TRIGGERING, per provider.
 *
 * The trigger is `threshold × min(contextWindow, cap)`. A cap moves only when
 * compaction summarizes; the model's true window still governs hard limits
 * (request size, output budgets), and min() keeps a smaller advertised window
 * authoritative — a cap never raises a trigger.
 *
 * Every entry below needs evidence of ONE of these, cited inline:
 *
 *   - a hard input limit below the advertised window;
 *   - measured slow turns (re-prefill without prompt caching);
 *   - a price tier that reprices the WHOLE request once the prompt crosses a
 *     size, so every turn past it costs more;
 *   - the vendor's own agent compacting this model earlier on the same route.
 *
 * "uncapped" needs evidence too: automatic prompt caching with cheap cache
 * hits and no long-context tier, or measured fast turns at large sizes.
 * Providers with no evidence either way keep {@link DEFAULT_LATENCY_WINDOW_CAP}.
 * Verified 2026-10-16 against the vendors' agents in source (deepseek-harness,
 * gemini-cli, qwen-code, codex, CodeWhale's model/pricing tables) and docs.
 */
const PROVIDER_WINDOW_CAPS: Partial<Record<Provider, number | "uncapped">> = {
  // Measured: TTFT 1.1s <50K → 3.6s at 700K–1M, ~100% cache reads over
  // 26,000+ turns (session logs, 2026-10). No long-context price tier. Claude
  anthropic: "uncapped",
  // Price line: once input passes 272K, OpenAI bills the WHOLE request at 2×
  // input/cache and 1.5× output (OpenAI model pages, via CodeWhale pricing.rs
  // OPENAI_LONG_CONTEXT_SURCHARGE_THRESHOLD). Codex itself stays under it,
  // compacting at 90% of a 272K window (codex-rs/protocol/src/openai_models.rs
  // auto_compact_token_limit). Trigger 231K on both routes: the API key's
  // 1.05M window is capped here, the Codex OAuth route already passes 272K.
  openai: 272_000,
  // Measured slow: every turn re-prefilled the whole context on the Coding
  // Plan endpoint at ~3–5K tok/s (2026-09-22 sidecar log: 44–68s TTFT at 213K).
  glm: 176_000,
  // DeepSeek's own agent compacts at 80% of a 1M window with no cap
  // (deepseek-harness packages/compaction: ratio 0.8, DEFAULT_CONTEXT_WINDOW
  // 1_000_000). Automatic prefix caching, hits ~1/50 of a miss (pi models:
  // cacheRead 0.006 vs input 0.30), no long-context surcharge.
  deepseek: "uncapped",
  // Kimi K3: automatic caching, hit $0.30 vs miss $3.00, no long-context tier
  // (platform.kimi.ai pricing, via CodeWhale pricing.rs). Kimi For Coding
  // (K2.8 Preview) serves up to 1M (kimi.com/code/docs).
  moonshot: "uncapped",
  // Measured slow past 200K: mimo-v2.6-pro TTFT p50 4.1s at 50–100K, 7.3s at
  // 150–200K, 12.5s at 200–250K (2,377 turns, session logs 2026-10/11), even
  // with 95–100% cache reads. Trigger 170K keeps turns under the cliff.
  xiaomi: 200_000,
  // MiniMax-M3 doubles its price once input passes 512K (0.30 → 0.60 in, cache
  // 0.06 → 0.12: CodeWhale pricing.rs MINIMAX_M3_LONG_CONTEXT_THRESHOLD, from
  // MiniMax's pay-as-you-go page), and 512K is the guaranteed window; "1M" is
  // up to. Trigger 435K stays under the line.
  minimax: 512_000,
  // Google's own Gemini CLI compresses at 50% of the window on this same
  // Code Assist route (packages/cli/src/ui/constants.ts
  // DEFAULT_COMPRESSION_THRESHOLD = 0.5; tokenLimit 1_048_576 for every
  // Gemini model), and implicit caching on Code Assist is unverified. 616K ×
  // 0.85 = 524K ≈ 50% of 1,048,576. Flash and Flash Lite are flat-priced at any
  // prompt size; 3.1 Pro has its own price-line cap in MODEL_WINDOW_CAPS.
  gemini: 616_000,
  // Price line: xAI bills the WHOLE request at 2× ($4 / $1 cached / $12) once a
  // grok-4.7 prompt reaches 200K tokens (docs.x.ai/developers/pricing;
  // CodeWhale pricing.rs GROK_4_6_LONG_CONTEXT_THRESHOLD = 200_000). Trigger
  // 170K stays under the line.
  xai: 200_000,
  // Qwen's own agent (qwen-code) runs qwen3.8-max at a 1M window and compacts
  // at 85% (chatCompressionService DEFAULT_PCT). OpenRouter lists cache reads
  // at $0.25 vs $2.00 input and no long-context tier.
  openrouter: "uncapped",
};

/**
 * Per-model caps, checked before the provider's rule: a model whose pricing
 * differs from the rest of its provider.
 */
const MODEL_WINDOW_CAPS: Readonly<Record<string, number>> = {
  // Price line: Gemini 3.1 Pro bills the WHOLE request at $4 / $18 instead of
  // $2 / $12 once the prompt passes 200K tokens (Gemini API pricing); the
  // Flash models stay flat. On a Code Assist licence this compacts earlier than
  // Gemini CLI's 50%, which keeps API-key users off the higher rate.
  "gemini-3.1-pro-preview": 200_000,
};

/** Conservative ceiling for providers with NO evidence either way (Sakana, the
 *  Hugging Face router — whose served window and caching vary by backend).
 *  Only bites windows above ~470K; 200–272K windows are unaffected. */
const DEFAULT_LATENCY_WINDOW_CAP = 400_000;

/**
 * Default absolute trigger for every provider and model (settings
 * `compactAtTokens` overrides it; set it higher to compact later). Measured on
 * claude-opus-5-5, 122K turns with ~100% cache reads: TTFT p50 1.1s <50K,
 * 1.9s at 200K, 2.8s at 400K, then 4.0–4.4s from 500K. gpt-6-astra (3.6s →
 * 6.6s by 200K) and mimo-v2.6-pro rise the same way, so the curve is not
 * Anthropic-specific. Replaying 11,766 real Anthropic turns: trigger 850K →
 * 400K cuts TTFT p50 2.74s → 1.99s for ~2 extra summaries per 1,000 turns.
 * Providers whose own cap is lower (OpenAI, GLM, xAI, Gemini, Xiaomi, …) are
 * unaffected — min() keeps the smaller trigger.
 */
export const DEFAULT_COMPACT_AT_TOKENS = 400_000;

/** The effective trigger window cap for a provider (and model), if one applies. */
export function resolveLatencyWindowCap(provider: Provider, model?: string): number | undefined {
  const modelCap = model === undefined ? undefined : MODEL_WINDOW_CAPS[model];
  if (modelCap !== undefined) return modelCap;
  const rule = PROVIDER_WINDOW_CAPS[provider];
  if (rule === "uncapped") return undefined;
  return rule ?? DEFAULT_LATENCY_WINDOW_CAP;
}

export interface CompactionPolicy {
  threshold: number;
  targetTokens: number;
  policyKey: string;
}

/** One trigger policy shared by app sessions and CLI compaction. */
export function resolveCompactionPolicy(options: {
  provider: Provider;
  model: string;
  contextWindow: number;
  threshold?: number;
  /** Absolute trigger ceiling (settings `compactAtTokens`; unset =
   *  {@link DEFAULT_COMPACT_AT_TOKENS}). The trigger is
   *  min(threshold × window, compactAtTokens). Compaction collapses history to a summary plus
   *  a small recent tail, so the context lands far below this target and the
   *  trigger does not re-fire on the next turn. */
  compactAtTokens?: number;
  accountId?: string;
  approvedPlanPath?: string;
}): CompactionPolicy {
  const threshold =
    Number.isFinite(options.threshold) && options.threshold! > 0 && options.threshold! < 1
      ? options.threshold!
      : DEFAULT_COMPACTION_THRESHOLD;
  const latencyCap = resolveLatencyWindowCap(options.provider, options.model);
  // The trigger fires against the latency-capped window when one applies —
  // min() keeps a provider-declared window smaller than the cap authoritative.
  const effectiveWindow = latencyCap
    ? Math.min(options.contextWindow, latencyCap)
    : options.contextWindow;
  const windowTarget = Math.max(1, Math.ceil(effectiveWindow * threshold));
  const absoluteTarget =
    options.compactAtTokens !== undefined &&
    Number.isFinite(options.compactAtTokens) &&
    options.compactAtTokens > 0
      ? Math.ceil(options.compactAtTokens)
      : DEFAULT_COMPACT_AT_TOKENS;
  const targetTokens = Math.min(windowTarget, absoluteTarget);
  const transport =
    options.provider === "openai" && options.accountId ? "codex_oauth" : "public_api";
  return {
    threshold,
    targetTokens,
    policyKey: JSON.stringify({
      provider: options.provider,
      model: options.model,
      transport,
      contextWindow: effectiveWindow,
      threshold,
      approvedPlanPath: options.approvedPlanPath ?? null,
      ...(absoluteTarget < windowTarget ? { compactAtTokens: absoluteTarget } : {}),
    }),
  };
}
