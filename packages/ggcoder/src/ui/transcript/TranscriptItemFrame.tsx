import React from "react";
import { Box } from "ink";

interface TranscriptItemFrameProps {
  children: React.ReactNode;
  marginTop: number;
}

export function TranscriptItemFrame({ children, marginTop }: TranscriptItemFrameProps) {
  if (marginTop <= 0) return <>{children}</>;
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      {children}
    </Box>
  );
}
