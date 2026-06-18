import { useEffect, useRef, useState } from "react";
import { AppWindow } from "lucide-react";
import { theme } from "./theme";
import { setupWindows, arrangeAllWindows } from "./agent";
import { playSound } from "./sounds";

/**
 * Top-right control that tiles the app into a 2-, 4-, or 6-window grid (macOS
 * fill&arrange style). Each new window is a separate project with its own agent.
 * Windows open immediately; project selection happens per-window afterwards.
 *
 * `onArrange` fires when a multi-window layout is applied (count > 1) so the
 * caller can auto-hide the nav bar — tiled windows are tight on space, and the
 * setting is persisted, so the freshly opened windows boot hidden too.
 */
export function WindowLayoutButton({ onArrange }: { onArrange?: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const id = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  async function applyLayout(count: number): Promise<void> {
    setOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      if (count > 1) {
        onArrange?.();
        playSound("hover");
      }
      await setupWindows(count);
    } finally {
      setBusy(false);
    }
  }

  async function arrangeAll(): Promise<void> {
    setOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      await arrangeAllWindows();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="winlayout" ref={ref}>
      <button
        className="btn btn-ghost btn-sm"
        disabled={busy}
        title="Arrange into multiple project windows"
        onClick={() => setOpen((o) => !o)}
      >
        <AppWindow size={16} />
      </button>
      {open && (
        <>
          {/* Full-screen catcher: closes the menu on any outside click. The
              document `mousedown` listener can't see clicks on Tauri
              `data-tauri-drag-region` areas (the OS swallows them for window
              dragging), so this backdrop guarantees dismissal. */}
          <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />
          <div
            className="winlayout-menu"
            style={{ background: theme.surface2, borderColor: theme.border }}
          >
            <button
              className="winlayout-item"
              style={{ color: theme.text }}
              onClick={() => void applyLayout(2)}
            >
              2 windows
            </button>
            <button
              className="winlayout-item"
              style={{ color: theme.text }}
              onClick={() => void applyLayout(4)}
            >
              4 windows
            </button>
            <button
              className="winlayout-item"
              style={{ color: theme.text }}
              onClick={() => void applyLayout(6)}
            >
              6 windows
            </button>
            <div className="winlayout-divider" />
            <button
              className="winlayout-item"
              style={{ color: theme.text }}
              onClick={() => void arrangeAll()}
            >
              Auto-arrange all
            </button>
          </div>
        </>
      )}
    </div>
  );
}
