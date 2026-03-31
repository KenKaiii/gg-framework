import React, { createContext, useContext } from "react";
import { Text, Box } from "ink";
import { NoSelect } from "./NoSelect.js";
import { Ratchet } from "./Ratchet.js";
import { RETURN_SYMBOL } from "../constants/figures.js";

interface Props {
  children: React.ReactNode;
  height?: number;
}

/**
 * Context that prevents nested MessageResponse components from rendering
 * duplicate ⎿ brackets — child MessageResponses check the context and
 * return just their children without the bracket wrapper.
 */
const MessageResponseContext = createContext(false);

/**
 * Tool result bracket wrapper.
 *
 * Renders the `⎿` bracket pattern used by claude-code to visually
 * distinguish tool output from regular text:
 *
 * ```
 *   ⎿  [content]
 * ```
 *
 * - Left gutter: 2 spaces + bracket + 2 spaces (6 chars), dimColor,
 *   wrapped in NoSelect so terminal copy-paste skips the bracket.
 * - React Context prevents nested brackets when a tool result contains
 *   another tool result (e.g. subagent output).
 * - Wrapped in Ratchet (lock="offscreen") to prevent height shrinking
 *   during streaming re-parses, unless an explicit height is provided.
 */
export function MessageResponse({ children, height }: Props): React.ReactNode {
  const isNested = useContext(MessageResponseContext);

  // Prevent double brackets in nested tool results
  if (isNested) {
    return <>{children}</>;
  }

  const content = (
    <MessageResponseContext value={true}>
      <Box flexDirection="row" height={height} overflowY="hidden">
        <NoSelect fromLeftEdge flexShrink={0}>
          <Text dimColor>
            {"  "}
            {RETURN_SYMBOL}
            {"  "}
          </Text>
        </NoSelect>
        <Box flexShrink={1} flexGrow={1}>
          {children}
        </Box>
      </Box>
    </MessageResponseContext>
  );

  if (height !== undefined) {
    return content;
  }

  return <Ratchet lock="offscreen">{content}</Ratchet>;
}
