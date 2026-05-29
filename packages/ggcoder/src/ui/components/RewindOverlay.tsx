import React, { useState } from "react";
import { Overlay } from "./Overlay.js";
import { SlashStyledSelectList } from "./SlashStyledSelectList.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import type { CheckpointInfo, RestoreMode } from "../../core/checkpoint-store.js";

// Overlay adds a rounded border (1 cell each side) + paddingX={1} (1 each side):
// reserve 4 columns so the inner list never overflows the terminal width, which
// would corrupt Ink's frame and restack the panel border.
const OVERLAY_CHROME_WIDTH = 4;

interface RewindOverlayProps {
  checkpoints: readonly CheckpointInfo[];
  onRestore: (id: string, mode: RestoreMode) => void;
  onCancel: () => void;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/**
 * Two-step `/rewind` picker, styled to match the `/model` and `/theme`
 * selectors (SlashStyledSelectList — same colors, columns, and key handling).
 * Step 1 selects a checkpoint (one per turn); step 2 picks a restore mode.
 * Mirrors Claude Code's three restore modes: code only, conversation only, both.
 *
 * Caveat shown in the copy: only edits made through ggcoder's write/edit tools
 * are tracked — changes made by bash (sed, rm, codegen) are not captured.
 */
export function RewindOverlay({ checkpoints, onRestore, onCancel }: RewindOverlayProps) {
  const { columns } = useTerminalSize();
  const listWidth = Math.max(20, columns - OVERLAY_CHROME_WIDTH);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Newest checkpoint first.
  const ordered = [...checkpoints].sort((a, b) => b.turnIndex - a.turnIndex);

  if (!selectedId) {
    const items = ordered.map((cp) => ({
      label: `#${cp.turnIndex} · ${relativeTime(cp.timestamp)}`,
      value: cp.id,
      description:
        cp.changedFileCount > 0
          ? `${cp.changedFileCount} file${cp.changedFileCount === 1 ? "" : "s"}: ${cp.summary}`
          : "no file changes",
    }));
    return (
      <Overlay title="Rewind to checkpoint">
        <SlashStyledSelectList
          items={items}
          onSelect={(id) => setSelectedId(id)}
          onCancel={onCancel}
          maxItemsToShow={10}
          width={listWidth}
        />
      </Overlay>
    );
  }

  const modeItems = [
    { label: "both", value: "both", description: "Restore files and chat" },
    { label: "code", value: "code", description: "Restore files on disk" },
    { label: "conversation", value: "conversation", description: "Rewind chat history" },
  ];
  return (
    <Overlay title="Restore mode">
      <SlashStyledSelectList
        items={modeItems}
        onSelect={(mode) => onRestore(selectedId, mode as RestoreMode)}
        onCancel={() => setSelectedId(null)}
        width={listWidth}
      />
    </Overlay>
  );
}
