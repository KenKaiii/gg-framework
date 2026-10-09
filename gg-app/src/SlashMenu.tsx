import { useEffect, useRef } from "react";
import { theme } from "./theme";
import type { SlashCommand } from "./agent";
import { useScrollEdges } from "./popover";

interface Props {
  commands: readonly SlashCommand[];
  /** Highlighted index (driven by ↑/↓ in the input). */
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}

/**
 * Upward command palette anchored to the chat input. Lists "plays" — the slash
 * commands matching the current `/prefix` — with name + description. Keyboard
 * nav (↑/↓/Enter/Esc) lives in the input's onKeyDown; this is presentational.
 */
export function SlashMenu({ commands, activeIndex, onSelect, onHover }: Props): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, true);
  // Keep the active row scrolled into view as the selection moves.
  useEffect(() => {
    document
      .querySelector(`.slash-item[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="slash-menu" style={{ background: theme.surface2, borderColor: theme.border }}>
      <div className="slash-menu-title" style={{ color: theme.textMuted }}>
        plays
      </div>
      <div ref={scrollRef} className="pop-scroll slash-scroll" onScroll={onScroll}>
        {commands.map((cmd, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={cmd.name}
              data-idx={i}
              className={`slash-item${active ? " active" : ""}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(cmd)}
            >
              <span className="slash-name" style={{ color: theme.commandColor }}>
                /{cmd.name}
              </span>
              <span className="slash-desc" style={{ color: theme.textMuted }}>
                {cmd.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
