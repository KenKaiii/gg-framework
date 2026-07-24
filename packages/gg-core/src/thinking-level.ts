import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { getMaxThinkingLevel } from "./model-registry.js";

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

function isOpenAIGptModel(provider: Provider, model: string): boolean {
  return provider === "openai" && model.startsWith("gpt-");
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

  const levels = model.startsWith("gpt-5.6-")
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
    isMoonshotK3Model(provider, model);
  if (!shouldCycleLevels) {
    return current ? undefined : supportedLevels[0];
  }

  if (!current) return supportedLevels[0];
  const index = supportedLevels.indexOf(current);
  if (index === -1) return supportedLevels[0];
  return supportedLevels[index + 1];
}
