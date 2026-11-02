import { useEffect, useRef } from "react";
import { ClockCounterClockwiseIcon, TerminalIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import type { ShellSuggestion } from "./agent";
import { useScrollEdges } from "./popover";
import { shellSuggestionNote } from "./shell-menu";

interface Props {
  suggestions: readonly ShellSuggestion[];
  /** Highlighted index (driven by ↑/↓ in the input). */
  activeIndex: number;
  /** This project runs commands without asking; offer to turn that off. */
  trusted: boolean;
  onRevokeTrust: () => void;
  onSelect: (s: ShellSuggestion) => void;
  onHover: (index: number) => void;
}

/**
 * Upward command picker anchored to the chat input, opened by typing `!`.
 * Same chrome and keyboard model as the `@` file picker: commands the user ran
 * here (most used first), then ones that fit the project.
 */
export function ShellCommandMenu({
  suggestions,
  activeIndex,
  trusted,
  onRevokeTrust,
  onSelect,
  onHover,
}: Props): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, true);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    document
      .querySelector(`.shell-menu-item[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="slash-menu" style={{ background: theme.surface2, borderColor: theme.border }}>
      <div className="slash-menu-title" style={{ color: theme.textMuted }}>
        commands
      </div>
      <div ref={scrollRef} className="pop-scroll slash-scroll" onScroll={onScroll}>
        {suggestions.map((s, i) => {
          const active = i === activeIndex;
          const note = shellSuggestionNote(s);
          const Icon = s.count > 0 ? ClockCounterClockwiseIcon : TerminalIcon;
          return (
            <button
              key={s.command}
              type="button"
              data-idx={i}
              className={`slash-item mention-item shell-menu-item${active ? " active" : ""}`}
              onMouseEnter={() => onHover(i)}
              // Keep the caret in the input, as the other pickers do.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSelect(s)}
            >
              <span className="mention-icon" style={{ color: theme.textMuted }}>
                <Icon size={14} />
              </span>
              <span className="shell-menu-command" style={{ color: theme.text }}>
                {s.command}
              </span>
              {note && (
                <span className="shell-menu-note" style={{ color: theme.textMuted }}>
                  {note}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {trusted && (
        <div className="shell-menu-foot" style={{ color: theme.textMuted }}>
          Commands run here without asking.
          <button
            type="button"
            className="shell-menu-revoke"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onRevokeTrust}
          >
            Ask first instead
          </button>
        </div>
      )}
    </div>
  );
}
