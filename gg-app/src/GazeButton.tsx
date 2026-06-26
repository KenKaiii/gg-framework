import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { isGazeEnabled, onGazeEnabledChange, toggleGazeEnabled } from "./gaze/state";

/**
 * Nav button that toggles webcam gaze → window focus. Only rendered inside a
 * project view (the project nav row), since gaze focus is about moving between
 * open project windows. Shares its on/off state with the GazeController and the
 * Cmd/Ctrl+Shift+G hotkey, so the icon reflects the live state from any source.
 */
export function GazeButton(): React.ReactElement {
  const [enabled, setEnabled] = useState<boolean>(isGazeEnabled);

  // Reflect toggles from the hotkey or other windows.
  useEffect(() => onGazeEnabledChange(setEnabled), []);

  return (
    <button
      className={`btn btn-sm btn-nav-icon ${enabled ? "btn-primary" : "btn-ghost"}`}
      title={
        enabled
          ? "Gaze focus on — look at a window to focus it (\u2318/Ctrl+Shift+G)"
          : "Gaze focus: look at a window to focus it (\u2318/Ctrl+Shift+G)"
      }
      aria-pressed={enabled}
      onClick={() => setEnabled(toggleGazeEnabled())}
    >
      {enabled ? <Eye size={16} /> : <EyeOff size={16} />}
    </button>
  );
}
