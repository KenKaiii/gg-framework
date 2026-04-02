import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/theme.js";

interface RemoteControlBannerProps {
  socketPath: string;
  clientCount: number;
}

export function RemoteControlBanner({ socketPath, clientCount }: RemoteControlBannerProps) {
  const theme = useTheme();

  const clientText =
    clientCount === 0
      ? "waiting for connection"
      : clientCount === 1
        ? "1 client connected"
        : `${clientCount} clients connected`;

  return (
    <Box
      borderStyle="round"
      borderColor={theme.accent}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      <Text>
        <Text color={theme.accent}>🔌 Remote control active</Text>
        <Text color={theme.textDim}> · {clientText}</Text>
      </Text>
      <Text color={theme.textDim}>
        socket: <Text color={theme.secondary}>{socketPath}</Text>
      </Text>
    </Box>
  );
}
