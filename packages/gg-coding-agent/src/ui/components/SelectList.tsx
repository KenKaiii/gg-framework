import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme/theme.js";

const MAX_VISIBLE_ITEMS = 10;

interface SelectListItem {
  label: string;
  value: string;
  description?: string;
}

interface SelectListProps {
  items: SelectListItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  initialIndex?: number;
}

export function SelectList({ items, onSelect, onCancel, initialIndex = 0 }: SelectListProps) {
  const theme = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter) return items;
    const lower = filter.toLowerCase();
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(lower) || item.value.toLowerCase().includes(lower),
    );
  }, [items, filter]);

  // Viewport slicing — keep selectedIndex visible
  const startIndex = useMemo(() => {
    if (filtered.length <= MAX_VISIBLE_ITEMS) return 0;
    const idealStart = Math.max(0, selectedIndex - MAX_VISIBLE_ITEMS + 1);
    return Math.min(idealStart, filtered.length - MAX_VISIBLE_ITEMS);
  }, [filtered.length, selectedIndex]);

  const visibleItems = useMemo(
    () => filtered.slice(startIndex, startIndex + MAX_VISIBLE_ITEMS),
    [filtered, startIndex],
  );

  const itemsAbove = startIndex;
  const itemsBelow = Math.max(0, filtered.length - startIndex - MAX_VISIBLE_ITEMS);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      if (filtered.length > 0) {
        onSelect(filtered[selectedIndex].value);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1));
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

  return (
    <Box flexDirection="column">
      {filter && (
        <Box marginBottom={1}>
          <Text color={theme.textDim}>Filter: {filter}</Text>
        </Box>
      )}
      {itemsAbove > 0 && <Text color={theme.textDim}> ↑ {itemsAbove} more</Text>}
      {visibleItems.map((item, i) => {
        const realIndex = startIndex + i;
        return (
          <Box key={item.value}>
            <Text color={realIndex === selectedIndex ? theme.primary : theme.text}>
              {realIndex === selectedIndex ? "❯ " : "  "}
              {item.label}
            </Text>
            {item.description && <Text color={theme.textDim}> — {item.description}</Text>}
          </Box>
        );
      })}
      {itemsBelow > 0 && <Text color={theme.textDim}> ↓ {itemsBelow} more</Text>}
      {filtered.length === 0 && <Text color={theme.textDim}>No matches</Text>}
      <Box marginTop={1}>
        <Text color={theme.textDim}>↑↓ navigate · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}
