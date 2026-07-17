import React, { useMemo } from "react";
import type { Provider } from "@kenkaiiii/gg-ai";
import { MODELS } from "../../core/model-registry.js";
import { SlashStyledSelectList } from "./SlashStyledSelectList.js";

interface ModelSelectorProps {
  onSelect: (modelId: string) => void;
  onCancel: () => void;
  loggedInProviders: Provider[];
  currentModel: string;
  currentProvider: Provider;
}

const MAX_MODELS_TO_SHOW = 6;

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  glm: "Z.AI",
  moonshot: "Moonshot",
  xiaomi: "Xiaomi",
  minimax: "MiniMax",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  sakana: "Sakana",
  xai: "xAI",
};

export function ModelSelector({
  onSelect,
  onCancel,
  loggedInProviders,
  currentModel,
  currentProvider,
}: ModelSelectorProps) {
  const currentValue = `${currentProvider}:${currentModel}`;

  const items = useMemo(
    () =>
      MODELS.filter((m) => loggedInProviders.includes(m.provider)).map((m) => {
        const value = `${m.provider}:${m.id}`;
        const isCurrent = value === currentValue;
        return {
          label: `${isCurrent ? "* " : "  "}${m.id}`,
          value,
          description: PROVIDER_LABEL[m.provider] ?? m.provider,
        };
      }),
    [currentValue, loggedInProviders],
  );

  const initialIndex = Math.max(
    0,
    items.findIndex((item) => item.value === currentValue),
  );

  return (
    <SlashStyledSelectList
      items={items}
      onSelect={onSelect}
      onCancel={onCancel}
      initialIndex={initialIndex}
      maxItemsToShow={MAX_MODELS_TO_SHOW}
    />
  );
}
