import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/theme.js";
import { getModel } from "../../core/model-registry.js";
import type { ProviderStatus } from "../../core/oauth/types.js";

interface BannerProps {
  version: string;
  model: string;
  cwd: string;
  taskCount?: number;
  providerStatuses?: ProviderStatus[];
}

const LOGO_LINES = [
  " \u2584\u2580\u2580\u2580 \u2584\u2580\u2580\u2580",
  " \u2588 \u2580\u2588 \u2588 \u2580\u2588",
  " \u2580\u2584\u2584\u2580 \u2580\u2584\u2584\u2580",
];

// Extended gradient with reverse path for smooth animation loop
const DARK_GRADIENT = [
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

const LIGHT_GRADIENT = [
  "#2563eb",
  "#3358e0",
  "#414dd5",
  "#4f42ca",
  "#5d37bf",
  "#6b2cb4",
  "#7c3aed",
  "#6b2cb4",
  "#5d37bf",
  "#4f42ca",
  "#414dd5",
  "#3358e0",
];

const GAP = "   ";

export function Banner({ version, model, cwd, taskCount, providerStatuses }: BannerProps) {
  const theme = useTheme();
  const modelInfo = getModel(model);
  const modelName = modelInfo?.name ?? model;

  const home = process.env.HOME ?? "";
  const displayPath = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;

  // Static gradient — no animation needed since the banner is rendered once
  // into Ink's Static area. Animating here would waste CPU and could cause
  // visual duplicates on terminal resize.
  const shift = 0;
  const gradient = theme.name === "light" ? LIGHT_GRADIENT : DARK_GRADIENT;

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box>
        <GradientText text={LOGO_LINES[0]} shift={shift} gradient={gradient} />
        <Text>{GAP}</Text>
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
        <GradientText text={LOGO_LINES[1]} shift={shift} gradient={gradient} />
        <Text>{GAP}</Text>
        <Text color={theme.secondary}>{modelName}</Text>
        <Text color={theme.textDim}>{"  "}</Text>
        <Text color={theme.primary}>Shift+`</Text>
        <Text color={theme.textDim}> tasks</Text>
        {taskCount !== undefined && taskCount > 0 && (
          <Text color={theme.secondary}> ({taskCount})</Text>
        )}
        <Text color={theme.textDim}>{"  "}</Text>
        <Text color={theme.primary}>Shift+Tab</Text>
        <Text color={theme.textDim}> thinking</Text>
      </Box>
      <Box>
        <GradientText text={LOGO_LINES[2]} shift={shift} gradient={gradient} />
        <Text>{GAP}</Text>
        <Text color={theme.textDim}>{displayPath}</Text>
      </Box>
      {providerStatuses && providerStatuses.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {providerStatuses.map((ps) => (
            <Box key={ps.provider}>
              <Text color={ps.connected ? theme.success : theme.textDim}>
                {ps.connected ? "✓" : "✗"}
              </Text>
              <Text> </Text>
              <Text color={theme.text}>{ps.provider.padEnd(10)}</Text>
              <Text color={theme.textDim}>· </Text>
              <Text color={ps.connected ? (theme.textMuted ?? theme.text) : theme.textDim}>
                {ps.connected ? (ps.source ?? "connected") : "not connected"}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function GradientText({
  text,
  shift = 0,
  gradient,
}: {
  text: string;
  shift?: number;
  gradient: string[];
}) {
  const chars: React.ReactNode[] = [];
  let colorIdx = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " ") {
      chars.push(ch);
    } else {
      const color = gradient[(colorIdx + shift) % gradient.length];
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
