import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/theme.js";
import type { StatusPresentation } from "./presentation.js";

interface StatusRowProps {
  id: string;
  glyph?: string;
  children?: React.ReactNode;
  glyphColor?: string;
  bold?: boolean;
  muted?: boolean;
  presentation?: StatusPresentation;
}

export function StatusRow({
  id,
  glyph,
  children,
  glyphColor,
  bold,
  muted,
  presentation,
}: StatusRowProps) {
  const theme = useTheme();
  const color = glyphColor ?? theme.commandColor;
  const displayGlyph = presentation?.glyph ?? glyph ?? "";
  const displayBold = presentation?.bold ?? bold;
  const displayMuted = presentation?.muted ?? muted;
  const displayChildren = children ?? presentation?.text ?? "";

  return (
    <Box key={id} flexDirection="row" paddingLeft={1} flexShrink={1}>
      <Box width={2} flexShrink={0}>
        <Text color={color} bold={displayBold ?? true}>
          {displayGlyph}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text
          color={displayMuted ? theme.textDim : theme.commandColor}
          bold={displayBold}
          wrap="wrap"
        >
          {presentation?.label ? <Text color={theme.textDim}>{presentation.label}</Text> : null}
          {displayChildren}
          {presentation?.detail ? <Text color={theme.textDim}>{presentation.detail}</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}
