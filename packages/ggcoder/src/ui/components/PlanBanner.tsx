import React from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";

interface PlanBannerProps {
  status?: "researching" | "drafting" | "awaiting_approval";
}

// Minimum inner width needed for the ASCII art lines (39 content chars inside ║…║)
const FRAME_CONTENT_WIDTH = 39;
// ║ + space on each side = 4
const FRAME_OVERHEAD = 4;

function hLine(char: string, width: number): string {
  return char.repeat(width);
}

export function PlanBanner({ status = "researching" }: PlanBannerProps) {
  const theme = useTheme();
  const { columns } = useTerminalSize();

  const statusText =
    status === "awaiting_approval"
      ? "Awaiting approval..."
      : status === "drafting"
        ? "Drafting plan..."
        : "Researching...";

  // Scale the frame to terminal width, but never narrower than the ASCII art
  const innerWidth = Math.max(FRAME_CONTENT_WIDTH, columns - FRAME_OVERHEAD);
  const artPad = innerWidth - FRAME_CONTENT_WIDTH;

  const statusLine = "Read-only mode · " + statusText;
  const statusPad = Math.max(0, innerWidth - 2 - statusLine.length); // 2 = spaces inside ║

  return (
    <Box flexDirection="column" marginTop={1} width={columns}>
      <Text color={theme.planPrimary}>{"╔" + hLine("═", innerWidth + 2) + "╗"}</Text>
      <Text color={theme.planPrimary}>
        {"║ ▀█▀ █ █ █▀▀   █▀█ █   █▀█ █▄ █" + " ".repeat(artPad + 6) + "║"}
      </Text>
      <Text color={theme.planPrimary}>
        {"║  █  █▀█ ██▄   █▀▀ █▄▄ █▀█ █ ▀█" + " ".repeat(artPad + 6) + "║"}
      </Text>
      <Text color={theme.planPrimary}>{"╠" + hLine("═", innerWidth + 2) + "╣"}</Text>
      <Text color={theme.planPrimary}>
        {"║  "}
        <Text color={theme.planPrimary}>{"Read-only mode · "}</Text>
        <Text color={theme.planPrimary} bold>
          {statusText}
        </Text>
        {" ".repeat(statusPad) + "  ║"}
      </Text>
      <Text color={theme.planPrimary}>{"╚" + hLine("═", innerWidth + 2) + "╝"}</Text>
    </Box>
  );
}
