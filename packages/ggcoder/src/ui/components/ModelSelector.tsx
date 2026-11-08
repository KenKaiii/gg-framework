import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { Provider } from "@kleio/ai";
import { getModel, MODELS } from "../../core/model-registry.js";
import { useTheme } from "../theme/theme.js";
import { SlashStyledSelectList } from "./SlashStyledSelectList.js";

interface ModelSelectorProps {
  onSelect: (modelId: string) => void;
  onCancel: () => void;
  loggedInProviders: Provider[];
  currentModel: string;
  currentProvider: Provider;
}

const MAX_MODELS_TO_SHOW = 6;

/** Values of the "spend real money" confirmation. Cancel is listed first. */
export const PAID_CONFIRM_CANCEL = "__cancel__";
export const PAID_CONFIRM_YES = "__confirm_paid__";

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
  huggingface: "Hugging Face",
  sakana: "Sakana",
  xai: "xAI",
};

/** The `provider:model` value's model, when it spends real money. */
export function paidModelFor(
  value: string,
): { name: string; detail: string; label: string; standardName: string } | undefined {
  const model = getModel(value.slice(value.indexOf(":") + 1));
  if (!model?.billing?.paid) return undefined;
  const standard = model.billing.standardModel ? getModel(model.billing.standardModel) : undefined;
  return {
    name: model.name,
    detail: model.billing.detail,
    label: model.billing.label,
    standardName: standard?.name ?? "a standard model",
  };
}

export function ModelSelector({
  onSelect,
  onCancel,
  loggedInProviders,
  currentModel,
  currentProvider,
}: ModelSelectorProps) {
  const theme = useTheme();
  const currentValue = `${currentProvider}:${currentModel}`;
  // A real-money model waiting on an explicit yes. Picking it never switches
  // by itself; the list is replaced by a confirmation whose default is Cancel.
  const [pendingPaid, setPendingPaid] = useState<string | null>(null);

  const items = useMemo(
    () =>
      MODELS.filter((m) => loggedInProviders.includes(m.provider)).map((m) => {
        const value = `${m.provider}:${m.id}`;
        const isCurrent = value === currentValue;
        return {
          label: `${isCurrent ? "* " : "  "}${m.id}`,
          value,
          // Fast modes change what the user pays; say so where they pick it.
          description: [PROVIDER_LABEL[m.provider] ?? m.provider, m.billing?.label]
            .filter(Boolean)
            .join(" · "),
        };
      }),
    [currentValue, loggedInProviders],
  );

  const initialIndex = Math.max(
    0,
    items.findIndex((item) => item.value === currentValue),
  );

  const paid = pendingPaid ? paidModelFor(pendingPaid) : undefined;
  if (pendingPaid && paid) {
    return (
      <Box flexDirection="column">
        <Text color={theme.warning} bold>
          {paid.name} spends real money.
        </Text>
        <Text color={theme.text}>{paid.detail}</Text>
        <Text color={theme.textDim}>
          It stays on for this session only. Restarts and new sessions go back to{" "}
          {paid.standardName}, and sub-agents never use it.
        </Text>
        <SlashStyledSelectList
          items={[
            { label: "Cancel", value: PAID_CONFIRM_CANCEL, description: "keep the current model" },
            {
              label: "Use it and pay",
              value: PAID_CONFIRM_YES,
              description: paid.label,
            },
          ]}
          onSelect={(choice) => {
            if (choice === PAID_CONFIRM_YES) onSelect(pendingPaid);
            else setPendingPaid(null);
          }}
          onCancel={() => setPendingPaid(null)}
          initialIndex={0}
        />
      </Box>
    );
  }

  return (
    <SlashStyledSelectList
      items={items}
      onSelect={(value) => {
        if (value !== currentValue && paidModelFor(value)) setPendingPaid(value);
        else onSelect(value);
      }}
      onCancel={onCancel}
      initialIndex={initialIndex}
      maxItemsToShow={MAX_MODELS_TO_SHOW}
    />
  );
}
