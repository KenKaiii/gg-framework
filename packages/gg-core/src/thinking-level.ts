import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { getMaxThinkingLevel } from "./model-registry.js";

const OPENAI_GPT_THINKING_LEVELS: readonly ThinkingLevel[] = ["medium", "high", "xhigh"];
const ANTHROPIC_OPUS_48_47_THINKING_LEVELS: readonly ThinkingLevel[] = [
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

function isOpenAIGptModel(provider: Provider, model: string): boolean {
  return provider === "openai" && model.startsWith("gpt-");
}

function isAnthropicOpus48Or47Model(provider: Provider, model: string): boolean {
  return provider === "anthropic" && /opus-4-8|opus-4-7/.test(model);
}

function isAnthropicAdaptiveModel(provider: Provider, model: string): boolean {
  return provider === "anthropic" && /opus-4-8|opus-4-7|opus-4-6|sonnet-4-6/.test(model);
}

export function getSupportedThinkingLevels(
  provider: Provider,
  model: string,
): readonly ThinkingLevel[] {
  const maxLevel = getMaxThinkingLevel(model);
  if (isAnthropicAdaptiveModel(provider, model)) {
    const levels = isAnthropicOpus48Or47Model(provider, model)
      ? ANTHROPIC_OPUS_48_47_THINKING_LEVELS
      : ANTHROPIC_ADAPTIVE_THINKING_LEVELS;
    const maxIndex = levels.indexOf(maxLevel);
    if (maxIndex === -1) return ["low", "medium", "high"];
    return levels.slice(0, maxIndex + 1);
  }

  if (!isOpenAIGptModel(provider, model)) return [maxLevel];

  const maxIndex = OPENAI_GPT_THINKING_LEVELS.indexOf(maxLevel);
  if (maxIndex === -1) return ["medium"];
  return OPENAI_GPT_THINKING_LEVELS.slice(0, maxIndex + 1);
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
    isOpenAIGptModel(provider, model) || isAnthropicAdaptiveModel(provider, model);
  if (!shouldCycleLevels) {
    return current ? undefined : supportedLevels[0];
  }

  if (!current) return supportedLevels[0];
  const index = supportedLevels.indexOf(current);
  if (index === -1) return supportedLevels[0];
  return supportedLevels[index + 1];
}
