import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { getMaxThinkingLevel, getModel } from "./model-registry.js";

const OPENAI_GPT_THINKING_LEVELS: readonly ThinkingLevel[] = ["medium", "high", "xhigh"];
// GPT-5.6 and GPT-6.x (gpt-6-*, plus point releases like gpt-6.1-sol) share the
// six-rung Codex ladder (low → ultra); older GPT models only expose
// medium/high/xhigh.
const OPENAI_GPT_56_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
// Plain Fugu and Fugu Max stop at xhigh; Ultra adds max. Slice by the model ceiling.
const SAKANA_THINKING_LEVELS: readonly ThinkingLevel[] = ["high", "xhigh", "max"];
const DEEPSEEK_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "high", "max"];
// Grok reasoning models take reasoning_effort low/medium/high (server default
// high; reasoning can't be fully disabled — "off" just omits the param). The
// registered Grok (4.7) exposes the full ladder including the `xhigh` top
// rung (docs: low/medium/high default/xhigh); each model slices this ladder
// by its registry maxThinkingLevel.
const XAI_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh"];
// Opus 5.x / 4.7, Sonnet 5.5 and Haiku 5.5 expose the full ladder including xhigh.
// Other adaptive Anthropic models omit xhigh and would 400.
const ANTHROPIC_XHIGH_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const ANTHROPIC_ADAPTIVE_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "max",
];
// Kimi K3's effort ladder is declared server-side via /models think_efforts:
// ["low","high","max"] on both the public API (default max) and the Kimi For
// Coding OAuth endpoint (default high) — verified live 2026-07-21. Unlisted
// efforts are rejected with a 400, so expose exactly the declared rungs.
const MOONSHOT_K3_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "high", "max"];
// GLM's ladder is declared by the endpoint itself: an unknown effort 400s with
// `reasoning_effort must be one of: none, minimal, low, medium, high, xhigh,
// max` (verified live against glm-5.3, 2026-08-14). `none` is the thinking
// toggle's job and `minimal` has no ThinkingLevel counterpart, so expose the
// five rungs we can actually name. Effort is real, not cosmetic — measured
// end-to-end on one hard reasoning prompt: low 0.8K reasoning chars / 15s,
// high 3.2K / 28s, max 24.9K / 129s.
const GLM_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
/**
 * Effort ladder for locally hosted models. `xhigh`/`ultra` are deliberately
 * absent: no local server defines them (Ollama 0.32 answers
 * `invalid reasoning value: 'xhigh' (must be "high", "medium", "low", "max", or
 * "none")`). Each model's own ceiling comes from its endpoint — see
 * `toModelInfo` in local-models.ts.
 */
const LOCAL_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "max"];

function isOpenAIGptModel(provider: Provider, model: string): boolean {
  return provider === "openai" && model.startsWith("gpt-");
}

function isSakanaModel(provider: Provider): boolean {
  return provider === "sakana";
}

function isXaiModel(provider: Provider): boolean {
  return provider === "xai";
}

// K3 and K2.8 Preview (`kimi-for-coding`) declare the same low/high/max ladder.
function isMoonshotK3Model(provider: Provider, model: string): boolean {
  return provider === "moonshot" && (model === "kimi-k3" || model === "kimi-for-coding");
}

function isGlmModel(provider: Provider): boolean {
  return provider === "glm";
}

function isAnthropicXhighModel(provider: Provider, model: string): boolean {
  return (
    provider === "anthropic" && /opus-5|opus-4-8|opus-4-7|sonnet-5[-.]5|haiku-5[-.]5/.test(model)
  );
}

function isAnthropicAdaptiveModel(provider: Provider, model: string): boolean {
  return (
    provider === "anthropic" &&
    /opus-5|opus-4-8|opus-4-7|opus-4-6|sonnet-5|haiku-5|fable-5|mythos-5/.test(model)
  );
}

export function getSupportedThinkingLevels(
  provider: Provider,
  model: string,
): readonly ThinkingLevel[] {
  // Local models: reasoning support is per-model and probed, not assumed. A
  // non-reasoning local model must never be sent a reasoning_effort — Ollama
  // hard-400s (`"llama3.2" does not support thinking`) — so it offers no levels
  // at all and the thinking toggle stays hidden.
  if (provider === "local") {
    const info = getModel(model);
    if (!info?.supportsThinking) return [];
    // The ceiling is the endpoint's, set at discovery: Ollama takes
    // low/medium/high/max, while the other OpenAI-compatible servers only
    // define low/medium/high (verified — Ollama rejects xhigh outright).
    const maxIndex = LOCAL_THINKING_LEVELS.indexOf(info.maxThinkingLevel);
    return maxIndex === -1
      ? LOCAL_THINKING_LEVELS.slice(0, 3)
      : LOCAL_THINKING_LEVELS.slice(0, maxIndex + 1);
  }
  const maxLevel = getMaxThinkingLevel(model);
  // A gateway that published its effort ladder is authoritative: offer exactly
  // those rungs. Without this, a non-OpenAI model falls through to the
  // single-rung [maxLevel] branch below and the picker shows one choice even
  // though the endpoint declared four.
  const declared = getModel(model)?.thinkingLevels;
  if (declared && declared.length > 0) return declared;
  if (isAnthropicAdaptiveModel(provider, model)) {
    const levels = isAnthropicXhighModel(provider, model)
      ? ANTHROPIC_XHIGH_THINKING_LEVELS
      : ANTHROPIC_ADAPTIVE_THINKING_LEVELS;
    const maxIndex = levels.indexOf(maxLevel);
    if (maxIndex === -1) return ["low", "medium", "high"];
    return levels.slice(0, maxIndex + 1);
  }

  if (isSakanaModel(provider)) {
    const maxIndex = SAKANA_THINKING_LEVELS.indexOf(maxLevel);
    if (maxIndex === -1) return SAKANA_THINKING_LEVELS;
    return SAKANA_THINKING_LEVELS.slice(0, maxIndex + 1);
  }

  if (isXaiModel(provider)) {
    const maxIndex = XAI_THINKING_LEVELS.indexOf(maxLevel);
    if (maxIndex === -1) return XAI_THINKING_LEVELS;
    return XAI_THINKING_LEVELS.slice(0, maxIndex + 1);
  }

  if (isMoonshotK3Model(provider, model)) return MOONSHOT_K3_THINKING_LEVELS;
  if (provider === "deepseek") return DEEPSEEK_THINKING_LEVELS;

  if (isGlmModel(provider)) {
    const maxIndex = GLM_THINKING_LEVELS.indexOf(maxLevel);
    if (maxIndex === -1) return GLM_THINKING_LEVELS;
    return GLM_THINKING_LEVELS.slice(0, maxIndex + 1);
  }

  if (!isOpenAIGptModel(provider, model)) return [maxLevel];

  const levels =
    model.startsWith("gpt-5.6-") || model.startsWith("gpt-6-") || model.startsWith("gpt-6.")
      ? OPENAI_GPT_56_THINKING_LEVELS
      : OPENAI_GPT_THINKING_LEVELS;
  const maxIndex = levels.indexOf(maxLevel);
  if (maxIndex === -1) return ["medium"];
  return levels.slice(0, maxIndex + 1);
}

/**
 * The lowest effort `model` accepts — the first rung of its ladder, never
 * "off". Used for background work (compaction summaries, `model: fast`
 * agents) that runs on the active model but doesn't need deep reasoning.
 * Undefined only when the model cannot reason at all, since sending it any
 * effort would be rejected.
 */
export function getLowestThinkingLevel(
  provider: Provider,
  model: string,
): ThinkingLevel | undefined {
  if (getModel(model)?.supportsThinking === false) return undefined;
  return getSupportedThinkingLevels(provider, model)[0];
}

export function isThinkingLevelSupported(
  provider: Provider,
  model: string,
  level: ThinkingLevel,
): boolean {
  return getSupportedThinkingLevels(provider, model).includes(level);
}

export function getNextThinkingLevel(
  provider: Provider,
  model: string,
  current: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  const supportedLevels = getSupportedThinkingLevels(provider, model);
  const shouldCycleLevels =
    isOpenAIGptModel(provider, model) ||
    isAnthropicAdaptiveModel(provider, model) ||
    isSakanaModel(provider) ||
    isXaiModel(provider) ||
    isMoonshotK3Model(provider, model) ||
    isGlmModel(provider) ||
    provider === "deepseek" ||
    // Local servers take a real effort level, not just on/off: Ollama accepts
    // low/medium/high on `reasoning_effort` (verified against 0.32) and the
    // other OpenAI-compatible servers use the same three. A model that can't
    // reason at all already has no supported levels, so it never gets here.
    provider === "local";
  if (!shouldCycleLevels) {
    return current ? undefined : supportedLevels[0];
  }

  if (!current) return supportedLevels[0];
  const index = supportedLevels.indexOf(current);
  if (index === -1) return supportedLevels[0];
  return supportedLevels[index + 1];
}

/**
 * Reasoning effort ceiling applied while plan mode is active. Mirrors the
 * Codex CLI's `plan_mode_reasoning_effort` preset (currently `medium`):
 * plan mode is read-only exploration, and deep-reasoning models left at
 * high/xhigh/max spend enormous thinking budgets re-deriving context they
 * could not have acted on anyway.
 */
export const PLAN_MODE_THINKING_CAP: ThinkingLevel = "medium";

const THINKING_LADDER: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

/** Clamp a thinking level down to the plan-mode cap. Pass-through for
 * `undefined` (thinking off) and already-low levels. */
export function clampThinkingForPlanMode(
  level: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (!level) return level;
  return THINKING_LADDER.indexOf(level) > THINKING_LADDER.indexOf(PLAN_MODE_THINKING_CAP)
    ? PLAN_MODE_THINKING_CAP
    : level;
}
