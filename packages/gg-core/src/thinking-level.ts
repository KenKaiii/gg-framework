import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { getMaxThinkingLevel, getModel } from "./model-registry.js";

const OPENAI_GPT_THINKING_LEVELS: readonly ThinkingLevel[] = ["medium", "high", "xhigh"];
const OPENAI_GPT_56_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
// Sakana Fugu accepts exactly two reasoning efforts — "high" and "xhigh" — and
// rejects anything else. Expose both so users can pick the lighter tier instead
// of being forced into all-or-nothing xhigh.
const SAKANA_THINKING_LEVELS: readonly ThinkingLevel[] = ["high", "xhigh"];
// Grok reasoning models take reasoning_effort low/medium/high (server default
// high; reasoning can't be fully disabled — "off" just omits the param).
const XAI_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high"];
// Opus 5 / 4.7 expose the full ladder including xhigh ("extended capability for
// long-horizon work"). Other adaptive Anthropic models omit xhigh and would 400.
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
/**
 * Effort ladder for locally hosted models. `xhigh`/`ultra` are deliberately
 * absent: no local server defines them (Ollama 0.32 answers
 * `invalid reasoning value: 'xhigh' (must be "high", "medium", "low", "max", or
 * "none")`). Each model's own ceiling comes from its endpoint — see
 * `toModelInfo` in local-models.ts.
 */
const LOCAL_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "max"];

function resolvedModelIdentity(model: string): string {
  return getModel(model)?.modelIdentity ?? model;
}

function isOpenAIGptModel(provider: Provider, model: string): boolean {
  const identity = resolvedModelIdentity(model);
  return (
    (provider === "openai" && identity.startsWith("gpt-")) ||
    (provider === "azure" && identity === "gpt-5.6-sol")
  );
}

function isSakanaModel(provider: Provider): boolean {
  return provider === "sakana";
}

function isXaiModel(provider: Provider): boolean {
  return provider === "xai";
}

function isMoonshotK3Model(provider: Provider, model: string): boolean {
  return provider === "moonshot" && model === "kimi-k3";
}

function isAnthropicXhighModel(provider: Provider, model: string): boolean {
  return provider === "anthropic" && /opus-5|opus-4-8|opus-4-7/.test(model);
}

function isAnthropicAdaptiveModel(provider: Provider, model: string): boolean {
  return (
    provider === "anthropic" &&
    /opus-5|opus-4-8|opus-4-7|opus-4-6|sonnet-5|fable-5|mythos-5/.test(model)
  );
}

export function getSupportedThinkingLevels(
  provider: Provider,
  model: string,
): readonly ThinkingLevel[] {
  const modelInfo = getModel(model);
  if (modelInfo && !modelInfo.supportsThinking) return [];

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

  if (!isOpenAIGptModel(provider, model)) return [maxLevel];

  const identity = resolvedModelIdentity(model);
  const levels = identity.startsWith("gpt-5.6-")
    ? OPENAI_GPT_56_THINKING_LEVELS
    : OPENAI_GPT_THINKING_LEVELS;
  const maxIndex = levels.indexOf(maxLevel);
  if (maxIndex === -1) return ["medium"];
  return levels.slice(0, maxIndex + 1);
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

export function clampThinkingLevel(
  provider: Provider,
  model: string,
  current: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (!current || isThinkingLevelSupported(provider, model, current)) return current;
  return getNextThinkingLevel(provider, model, undefined);
}

/** Restore a saved thinking preference against the model selected at startup.
 * A deployment/config reload can change that model before a session is created. */
export function resolveInitialThinkingLevel(
  provider: Provider,
  model: string,
  enabled: boolean | undefined,
  savedLevel: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (!enabled) return undefined;
  return clampThinkingLevel(provider, model, savedLevel ?? getMaxThinkingLevel(model));
}
