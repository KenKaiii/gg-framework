import type { ReactNode } from "react";
import { theme } from "./theme";
import { toneColor, type ToolLinePart } from "./tool-format";

// BLACK_CIRCLE — ⏺, matching the TUI status figure.
const DOT = "\u23FA";

export type ToolRowState = "running" | "done" | "failed";

interface Props {
  parts: readonly ToolLinePart[];
  state: ToolRowState;
  /** "li" inside a list. */
  as?: "div" | "li";
  /** Hover text, for a line the row truncates. */
  title?: string;
  /** After the line, kept visible when the line truncates (a duration). */
  children?: ReactNode;
}

/**
 * One tool call, as the TUI shows it: a status dot + bold tone-coloured verb +
 * plain detail + dim inline summary. A running dot blinks; a finished one turns
 * green, a failed one red.
 */
export function ToolRow({ parts, state, as = "div", title, children }: Props): React.ReactElement {
  const Tag = as;
  const dotColor =
    state === "running" ? theme.primary : state === "failed" ? theme.error : theme.success;
  return (
    <Tag className="tool-row" title={title}>
      <span
        className={`tool-dot${state === "running" ? " blink" : ""}`}
        style={{ color: dotColor }}
        aria-hidden="true"
      >
        {DOT}
      </span>
      <span className="tool-line">
        {parts.map((p, i) => (
          <span
            key={i}
            style={{
              color: p.warn
                ? theme.warning
                : p.dim
                  ? theme.textDim
                  : p.tone
                    ? toneColor(p.tone)
                    : theme.text,
              fontWeight: p.bold ? 600 : 400,
            }}
          >
            {p.text}
          </span>
        ))}
      </span>
      {children}
    </Tag>
  );
}
