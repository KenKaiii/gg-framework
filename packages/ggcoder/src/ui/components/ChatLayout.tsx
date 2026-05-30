import React from "react";
import { Box, type DOMElement } from "ink";

interface ChatLayoutProps {
  columns: number;
  /**
   * When set, the layout root claims the full terminal height. Used by the
   * fullscreen alt-screen viewport so the bounded transcript region (flexGrow)
   * fills everything above the pinned controls, giving the footer a fixed
   * position at the very bottom of the screen.
   */
  rows?: number;
  children: React.ReactNode;
}

interface ChatLiveAreaProps {
  children: React.ReactNode;
  /**
   * When set, hard-cap the live area to this many rows, anchoring content to
   * the bottom (newest visible) and clipping the overflow at the top. Leave
   * undefined so the area stays compact (sized to its content) when it fits —
   * a fixed height would otherwise reserve blank rows above short output.
   */
  clampRows?: number;
}

interface ChatControlsProps {
  controlsRef: (node: DOMElement | null) => void;
  children: React.ReactNode;
}

interface ChatInputFooterStackProps {
  columns: number;
  children: React.ReactNode;
}

export function ChatLayout({ columns, rows, children }: ChatLayoutProps) {
  if (rows !== undefined) {
    return (
      <Box flexDirection="column" width={columns} height={rows} flexShrink={0} flexGrow={0}>
        {children}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={columns} flexShrink={0} flexGrow={0}>
      {children}
    </Box>
  );
}

export function ChatLiveArea({ children, clampRows }: ChatLiveAreaProps) {
  return (
    <Box
      flexDirection="column"
      flexGrow={0}
      flexShrink={1}
      overflowY="hidden"
      {...(clampRows !== undefined
        ? { height: clampRows, justifyContent: "flex-end" as const }
        : {})}
    >
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
