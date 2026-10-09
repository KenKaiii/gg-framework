import { useEffect, useRef } from "react";
import { FileTextIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import type { FileHit } from "./agent";
import { useScrollEdges } from "./popover";

interface Props {
  files: readonly FileHit[];
  /** Highlighted index (driven by ↑/↓ in the input). */
  activeIndex: number;
  /** Whether the current query is empty (drives the header label). */
  isRecent: boolean;
  onSelect: (file: FileHit) => void;
  onHover: (index: number) => void;
}

/**
 * Upward file picker anchored to the chat input, opened by typing `@`. Mirrors
 * SlashMenu: bright basename + dimmed directory path, file icon. Keyboard nav
 * (↑/↓/Tab/Enter/Esc) lives in the input's onKeyDown; this is presentational.
 */
export function FileMentionMenu({
  files,
  activeIndex,
  isRecent,
  onSelect,
  onHover,
}: Props): React.ReactElement {
  // Keep the active row scrolled into view as the selection moves. Skip the
  // first run (mount) so opening the menu never scrolls the page/transcript.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, true);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    document
      .querySelector(`.mention-item[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="slash-menu" style={{ background: theme.surface2, borderColor: theme.border }}>
      <div className="slash-menu-title" style={{ color: theme.textMuted }}>
        {isRecent ? "recent files" : "files"}
      </div>
      <div ref={scrollRef} className="pop-scroll slash-scroll" onScroll={onScroll}>
        {files.map((file, i) => {
          const active = i === activeIndex;
          const dir = file.path.slice(0, file.path.length - file.name.length);
          return (
            <button
              key={file.path}
              data-idx={i}
              className={`slash-item mention-item${active ? " active" : ""}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(file)}
            >
              <span className="mention-icon" style={{ color: theme.textMuted }}>
                <FileTextIcon size={14} />
              </span>
              <span className="mention-name" style={{ color: theme.text }}>
                {file.name}
              </span>
              {dir && (
                <span className="mention-dir" style={{ color: theme.textMuted }}>
                  {dir}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
