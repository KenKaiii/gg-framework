import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/theme.js";
import { getModel } from "../../core/model-registry.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import type { Provider } from "@kenkaiiii/gg-ai";

interface BannerProps {
  version: string;
  model: string;
  provider: Provider;
  cwd: string;
}

const LOGO_LINES = [
  " \u2588\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2588\u2557 ",
  "\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d ",
  "\u2588\u2588\u2551  \u2588\u2588\u2588\u2557\u2588\u2588\u2551  \u2588\u2588\u2588\u2557",
  "\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551",
  "\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d",
  " \u255a\u2550\u2550\u2550\u2550\u2550\u255d  \u255a\u2550\u2550\u2550\u2550\u2550\u255d",
];

// Extended gradient with reverse path for smooth animation loop
const GRADIENT = [
  "#60a5fa",
  "#6da1f9",
  "#7a9df7",
  "#8799f5",
  "#9495f3",
  "#a18ff1",
  "#a78bfa",
  "#a18ff1",
  "#9495f3",
  "#8799f5",
  "#7a9df7",
  "#6da1f9",
];

// One-space left pad to match the terminal-history banner (RESPONSE_LEFT_PADDING).
const LEFT_PAD = " ";
const GAP = "   ";
// Logo is 17 visible chars wide; below this width the info column would
// collide with the art, so we stack it underneath instead. The threshold
// mirrors terminal-history.ts SIDE_BY_SIDE_MIN (LOGO_WIDTH + GAP + 62).
const LOGO_WIDTH = 17;
const SIDE_BY_SIDE_MIN = LOGO_WIDTH + GAP.length + 62;

export function Banner({ version, model, cwd }: BannerProps) {
  const theme = useTheme();
  const { columns } = useTerminalSize();
  const modelInfo = getModel(model);
  const modelName = modelInfo?.name ?? model;

  const home = process.env.HOME ?? "";
  const displayPath = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;

  // Static gradient — no animation needed since the banner is rendered once
  // into Ink's Static area. Animating here would waste CPU and could cause
  // visual duplicates on terminal resize.
  const shift = 0;

  const logo = (
    <Box flexDirection="column" flexShrink={0}>
      {LOGO_LINES.map((line, i) => (
        <Box key={i}>
          <Text>{LEFT_PAD}</Text>
          <GradientText text={line} shift={shift} />
        </Box>
      ))}
    </Box>
  );

  // Narrow (stacked) info — mirrors terminal-history.ts: brand line omits
  // "· By Ken Kai", path is truncated to the full terminal width.
  const stackedInfo = (
    <Box flexDirection="column">
      <Box>
        <Text>{LEFT_PAD}</Text>
        <Text color={theme.primary} bold>
          GG Coder
        </Text>
        <Text color={theme.textDim}> v{version}</Text>
      </Box>
      <Box>
        <Text>{LEFT_PAD}</Text>
        <Text color={theme.secondary}>{modelName}</Text>
        <Text color={theme.textDim}>{"  "}</Text>
        <Text color={theme.textDim} wrap="truncate">
          {displayPath}
        </Text>
      </Box>
      <Box>
        <Text>{LEFT_PAD}</Text>
        <ShortcutHints />
      </Box>
    </Box>
  );

  // Side-by-side info — includes "· By Ken Kai".
  const sideInfo = (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.primary} bold>
          GG Coder
        </Text>
        <Text color={theme.textDim}> v{version}</Text>
        <Text color={theme.textDim}> · By </Text>
        <Text color={theme.text} bold>
          Ken Kai
        </Text>
      </Box>
      <Box>
        <Text color={theme.secondary}>{modelName}</Text>
        <Text color={theme.textDim}>{"  "}</Text>
        <Text color={theme.textDim} wrap="truncate">
          {displayPath}
        </Text>
      </Box>
      <ShortcutHints />
    </Box>
  );

  // At narrow widths, stack the info block under the logo.
  if (columns < SIDE_BY_SIDE_MIN) {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1} width={columns}>
        {logo}
        <Box marginTop={1}>{stackedInfo}</Box>
      </Box>
    );
  }

  // Side-by-side: logo on the left, info column vertically centered beside it.
  return (
    <Box flexDirection="row" marginTop={1} marginBottom={1} width={columns}>
      {logo}
      <Text>{GAP}</Text>
      <Box flexDirection="column" justifyContent="center">
        {sideInfo}
      </Box>
    </Box>
  );
}

function ShortcutHints() {
  const theme = useTheme();

  return (
    <Box>
      <Text color={theme.primary}>Ctrl+T</Text>
      <Text color={theme.textDim}> tasks</Text>
      <Text color={theme.textDim}> · </Text>
      <Text color={theme.primary}>Ctrl+S</Text>
      <Text color={theme.textDim}> skills</Text>
      <Text color={theme.textDim}> · </Text>
      <Text color={theme.primary}>Shift+Tab</Text>
      <Text color={theme.textDim}> toggle thinking</Text>
    </Box>
  );
}

function GradientText({ text, shift = 0 }: { text: string; shift?: number }) {
  const chars: React.ReactNode[] = [];
  let colorIdx = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " ") {
      chars.push(ch);
    } else {
      const color = GRADIENT[(colorIdx + shift) % GRADIENT.length];
      chars.push(
        <Text key={i} color={color}>
          {ch}
        </Text>,
      );
      colorIdx++;
    }
  }
  return <Text>{chars}</Text>;
}
