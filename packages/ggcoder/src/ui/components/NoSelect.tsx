import React, { type PropsWithChildren } from "react";
import { Box, type BoxProps } from "ink";

type Props = Omit<BoxProps, "children"> & {
  /**
   * Extend the exclusion zone from column 0 to this box's right edge.
   * Use for gutters rendered inside a wider indented container (e.g. the
   * MessageResponse bracket) so a multi-row drag picks up clean content.
   */
  fromLeftEdge?: boolean;
};

/**
 * Marks its contents as non-selectable in terminal text selection.
 *
 * If Ink supports the `noSelect` prop on Box this component passes it
 * through; otherwise it acts as a semantic wrapper and a single place
 * to wire the feature when Ink adds support.
 */
export function NoSelect({
  children,
  fromLeftEdge: _fromLeftEdge,
  ...boxProps
}: PropsWithChildren<Props>): React.ReactNode {
  return <Box {...boxProps}>{children}</Box>;
}
