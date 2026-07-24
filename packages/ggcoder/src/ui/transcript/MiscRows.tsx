import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/theme.js";
import type {
  DurationItem,
  ErrorItem,
  QueuedItem,
  StepDoneItem,
  StylePackItem,
  UpdateNoticeItem,
} from "../app-items.js";
import {
  presentDuration,
  presentError,
  presentQueued,
  presentStepDone,
  presentStylePack,
  presentUpdateNotice,
} from "./presentation.js";

export function StylePackRow({ item }: { item: StylePackItem }) {
  const theme = useTheme();
  const presentation = presentStylePack(item);

  return (
    <Box key={item.id} paddingLeft={1} flexShrink={1}>
      <Box
        flexShrink={1}
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.language}
        paddingX={1}
      >
        <Text wrap="wrap">
          <Text color={theme.language} bold>
            {"◆ "}
          </Text>
          <Text color={theme.language} bold>
            {presentation.headerLabel}
          </Text>
        </Text>
        <Text color={theme.text} bold wrap="wrap">
          {presentation.names}
        </Text>
      </Box>
    </Box>
  );
}

export function ErrorRow({ item }: { item: ErrorItem }) {
  const theme = useTheme();
  const presentation = presentError(item);

  return (
    <Box key={item.id} flexDirection="row" paddingLeft={1} flexShrink={1}>
      <Box width={2} flexShrink={0}>
        <Text color={theme.error} bold>
          {presentation.glyph}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.error} wrap="wrap">
          {presentation.headline}
        </Text>
        {presentation.message && (
          <Text color={theme.textDim} wrap="wrap">
            {presentation.message}
          </Text>
        )}
        <Text color={theme.textDim} wrap="wrap">
          {presentation.guidance}
        </Text>
      </Box>
    </Box>
  );
}

export function UpdateNoticeRow({ item }: { item: UpdateNoticeItem }) {
  const theme = useTheme();
  const presentation = presentUpdateNotice(item);

  return (
    <Box key={item.id} paddingLeft={1} flexShrink={1}>
      <Box flexShrink={1} borderStyle="round" borderColor={theme.commandColor} paddingX={1}>
        <Text color={theme.commandColor} bold wrap="wrap">
          {presentation.text}
        </Text>
      </Box>
    </Box>
  );
}

export function StepDoneRow({ item }: { item: StepDoneItem }) {
  const theme = useTheme();
  const presentation = presentStepDone(item);

  return (
    <Box key={item.id} paddingLeft={1} flexShrink={1}>
      <Text wrap="wrap">
        <Text color={theme.planPrimary} bold>
          {presentation.glyph}
        </Text>
        <Text color={theme.planPrimary} bold>
          {presentation.text}
        </Text>
        {presentation.description ? (
          <Text color={theme.accent}>{presentation.description}</Text>
        ) : null}
      </Text>
    </Box>
  );
}

export function QueuedRow({ item }: { item: QueuedItem }) {
  const theme = useTheme();
  const presentation = presentQueued(item);

  return (
    <Box key={item.id} flexDirection="row" paddingLeft={1} flexShrink={1}>
      <Box width={2} flexShrink={0}>
        <Text color={theme.warning} bold>
          {presentation.glyph}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.text} wrap="wrap">
          <Text color={theme.textDim}>{presentation.label}</Text>
          {presentation.text}
          {presentation.suffix}
        </Text>
      </Box>
    </Box>
  );
}

export function DurationRow({ item }: { item: DurationItem }) {
  const theme = useTheme();
  const presentation = presentDuration(item);

  return (
    <Box key={item.id} paddingLeft={1}>
      <Text color={theme.textDim}>
        {presentation.glyph}
        {presentation.text}
      </Text>
    </Box>
  );
}
