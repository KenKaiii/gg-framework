import React from "react";
import { Box, type DOMElement } from "ink";

interface ChatLayoutProps {
  columns: number;
  children: React.ReactNode;
}

interface ChatLiveAreaProps {
  children: React.ReactNode;
}

interface ChatControlsProps {
  controlsRef: (node: DOMElement | null) => void;
  children: React.ReactNode;
}

interface ChatInputFooterStackProps {
  columns: number;
  children: React.ReactNode;
}

export function ChatLayout({ columns, children }: ChatLayoutProps) {
  return (
    <Box flexDirection="column" width={columns} flexShrink={0} flexGrow={0}>
      {children}
    </Box>
  );
}

export function ChatLiveArea({ children }: ChatLiveAreaProps) {
  return (
    <Box flexDirection="column" flexGrow={0} flexShrink={1} overflowY="hidden">
      {children}
    </Box>
  );
}

export function ChatControls({ controlsRef, children }: ChatControlsProps) {
  return (
    <Box ref={controlsRef} flexDirection="column" flexShrink={0} flexGrow={0}>
      {children}
    </Box>
  );
}

export function ChatInputFooterStack({ columns, children }: ChatInputFooterStackProps) {
  return (
    <Box flexDirection="column" width={columns}>
      {children}
    </Box>
  );
}
