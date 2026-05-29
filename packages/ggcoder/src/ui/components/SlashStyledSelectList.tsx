import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useTheme } from "../theme/theme.js";
import { stripTerminalFocusSequences } from "../utils/terminal-input.js";

export interface SlashStyledSelectListItem {
  label: string;
  value: string;
  description: string;
}

interface SlashStyledSelectListProps {
  items: SlashStyledSelectListItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  initialIndex?: number;
  maxItemsToShow?: number;
  /**
   * Explicit content width. Defaults to the full terminal width. Pass a smaller
   * value when rendering inside a bordered/padded container (e.g. Overlay) so
   * the list doesn't overflow the terminal and corrupt Ink's frame.
   */
  width?: number;
}

const DEFAULT_MAX_ITEMS_TO_SHOW = 8;

export function SlashStyledSelectList({
  items,
  onSelect,
  onCancel,
  initialIndex = 0,
  maxItemsToShow = DEFAULT_MAX_ITEMS_TO_SHOW,
  width: widthOverride,
}: SlashStyledSelectListProps) {
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
      setFilter((f) => f.slice(0, -1));
      setSelectedIndex(0);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setFilter((f) => f + input);
      setSelectedIndex(0);
    }
  });

  const total = filtered.length;
  const idx = Math.min(Math.max(selectedIndex, 0), Math.max(0, total - 1));
  const start =
    total <= maxItemsToShow
      ? 0
      : Math.max(0, Math.min(idx - Math.floor(maxItemsToShow / 2), total - maxItemsToShow));
  const end = Math.min(start + maxItemsToShow, total);
  const visible = filtered.slice(start, end);
  const width = widthOverride ?? Math.max(20, columns);
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
      {total > maxItemsToShow && (
        <Text color={theme.textDim}>
          ({idx + 1}/{total})
        </Text>
      )}
      {total === 0 && <Text color={theme.textDim}>No matches</Text>}
    </Box>
  );
}
