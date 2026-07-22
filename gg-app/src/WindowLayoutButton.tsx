import { useState } from "react";
import { AppWindow } from "lucide-react";
import { setupWindows, arrangeAllWindows } from "./agent";
import { playSound } from "./sounds";

/**
 * Titlebar control that tiles the app into a 2-, 4-, or 6-window grid (macOS
 * fill&arrange style), or auto-arranges all open windows. Each new window is a
 * separate project with its own agent. Windows open immediately; project
 * selection happens per-window afterwards.
 *
 * Looks exactly like the old icon button, but a transparent native <select>
 * stretched over it takes the click and opens the OS-native dropdown (an
 * action picker with no persistent value — it snaps back to its placeholder
 * after each choice). No popover to position or dismiss.
 *
 * `onArrange` fires when a multi-window layout is applied (count > 1) so the
 * caller can auto-hide the nav bar — tiled windows are tight on space, and the
 * setting is persisted, so the freshly opened windows boot hidden too.
 */
export function WindowLayoutButton({ onArrange }: { onArrange?: () => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);

  async function run(choice: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (choice === "auto") {
        await arrangeAllWindows();
      } else {
        const count = Number(choice);
        if (count > 1) {
          onArrange?.();
          playSound("hover");
        }
        await setupWindows(count);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="winlayout">
      {/* Visual only — the overlaying select takes every click. Mirrors the
          old button: .btn .btn-ghost .btn-sm .btn-nav-icon + AppWindow icon. */}
      <span className="winlayout-icon-btn btn btn-ghost btn-sm btn-nav-icon" aria-hidden="true">
        <AppWindow size={16} />
      </span>
      <select
        className="winlayout-select"
        value=""
        disabled={busy}
        title="Arrange into multiple project windows"
        aria-label="Arrange into multiple project windows"
        onChange={(e) => {
          if (e.target.value) void run(e.target.value);
        }}
      >
        <option value="" disabled>
          Arrange
        </option>
        <option value="2">2 windows</option>
        <option value="4">4 windows</option>
        <option value="6">6 windows</option>
        <option value="auto">Auto-arrange all</option>
      </select>
    </span>
  );
}
