import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Provider } from "@kenkaiiii/gg-ai";
import { MODELS } from "@kenkaiiii/gg-core";
import { useTerminalSize } from "@kenkaiiii/ggcoder/ui/hooks/terminal-size";
import { useTheme } from "@kenkaiiii/ggcoder/ui/theme";

interface BossModelSelectorProps {
  onSelect: (modelId: string) => void;
  onCancel: () => void;
  currentModel: string;
  currentProvider: Provider;
}

interface BossModelSelectorItem {
  label: string;
  value: string;
  description: string;
}

const MAX_MODELS_TO_SHOW = 8;

const PROVIDER_LABEL: Partial<Record<Provider, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  glm: "Z.AI",
  moonshot: "Moonshot",
  xiaomi: "Xiaomi",
  minimax: "MiniMax",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

const ESC = String.fromCharCode(27);
const ESC_FOCUS_GAINED = `${ESC}[I`;
const ESC_FOCUS_LOST = `${ESC}[O`;
const ESC_LESS_FOCUS_GAINED = "[I";
const ESC_LESS_FOCUS_LOST = "[O";

function stripTerminalFocusSequences(input: string): string {
  const withoutEscFocusReports = input
    .replaceAll(ESC_FOCUS_GAINED, "")
    .replaceAll(ESC_FOCUS_LOST, "");
  let remaining = withoutEscFocusReports;

  while (remaining.length > 0) {
    if (remaining.startsWith(ESC_LESS_FOCUS_GAINED) || remaining.startsWith(ESC_LESS_FOCUS_LOST)) {
      remaining = remaining.slice(2);
      continue;
    }

    return withoutEscFocusReports;
  }

  return "";
}

function BossModelSelectList({
  items,
  onSelect,
  onCancel,
  initialIndex,
}: {
  items: BossModelSelectorItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  initialIndex: number;
}): React.ReactElement {
  const theme = useTheme();
  const { columns } = useTerminalSize();
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter) return items;
    const lower = filter.toLowerCase();
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(lower) ||
        item.value.toLowerCase().includes(lower) ||
        item.description.toLowerCase().includes(lower),
    );
  }, [items, filter]);

  useInput((input, key) => {
    const inputWithoutFocusReports = stripTerminalFocusSequences(input);
    if (!inputWithoutFocusReports && input) return;
    input = inputWithoutFocusReports;

    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const selected = filtered[selectedIndex];
      if (selected) onSelect(selected.value);
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((i) => (filtered.length === 0 ? 0 : Math.min(filtered.length - 1, i + 1)));
      return;
    }

    if (key.backspace || key.delete) {
      setFilter((current) => current.slice(0, -1));
      setSelectedIndex(0);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setFilter((current) => current + input);
      setSelectedIndex(0);
    }
  });

  const total = filtered.length;
  const idx = Math.min(Math.max(selectedIndex, 0), Math.max(0, total - 1));
  const start =
    total <= MAX_MODELS_TO_SHOW
      ? 0
      : Math.max(0, Math.min(idx - Math.floor(MAX_MODELS_TO_SHOW / 2), total - MAX_MODELS_TO_SHOW));
  const end = Math.min(start + MAX_MODELS_TO_SHOW, total);
  const visible = filtered.slice(start, end);
  const width = Math.max(20, columns);
  const maxLabelLength = Math.max(0, ...filtered.map((item) => item.label.length));
  const labelColumnWidth = Math.min(maxLabelLength, Math.floor(width * 0.5));

  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      {filter && <Text color={theme.textDim}>Filter: {filter}</Text>}
      {start > 0 && <Text color={theme.text}>▲</Text>}
      {visible.map((item, i) => {
        const actualIndex = start + i;
        const isSelected = actualIndex === idx;
        const textColor = isSelected ? theme.commandColor : theme.textDim;

        return (
          <Box
            key={item.value}
            flexDirection="row"
            backgroundColor={isSelected ? theme.border : undefined}
          >
            <Box width={labelColumnWidth} flexShrink={0}>
              <Text color={textColor}>{item.label}</Text>
            </Box>
            <Box flexGrow={1} paddingLeft={3}>
              <Text color={textColor} wrap="truncate">
                {item.description.slice(0, 100)}
              </Text>
            </Box>
          </Box>
        );
      })}
      {end < total && <Text color={theme.textDim}>▼</Text>}
      {total > MAX_MODELS_TO_SHOW && (
        <Text color={theme.textDim}>
          ({idx + 1}/{total})
        </Text>
      )}
      {total === 0 && <Text color={theme.textDim}>No matches</Text>}
    </Box>
  );
}

/**
 * GG Boss supports the same model registry as GG Coder. Unlike GG Coder's
 * shared picker, Boss deliberately shows the full registry instead of hiding
 * models behind the currently logged-in provider list: boss/worker switches can
 * be prepared from CLI settings, and a missing credential should fail with the
 * provider's normal login hint only when the model is actually selected.
 */
export function BossModelSelector({
  onSelect,
  onCancel,
  currentModel,
  currentProvider,
}: BossModelSelectorProps): React.ReactElement {
  const currentValue = `${currentProvider}:${currentModel}`;
  const items = useMemo(
    () =>
      MODELS.map((model) => {
        const value = `${model.provider}:${model.id}`;
        const isCurrent = value === currentValue;
        return {
          label: `${isCurrent ? "* " : "  "}${model.name}`,
          value,
          description: `${PROVIDER_LABEL[model.provider] ?? model.provider} · ${model.id}`,
        };
      }),
    [currentValue],
  );

  const initialIndex = Math.max(
    0,
    items.findIndex((item) => item.value === currentValue),
  );

  return (
    <BossModelSelectList
      items={items}
      onSelect={onSelect}
      onCancel={onCancel}
      initialIndex={initialIndex}
    />
  );
}
