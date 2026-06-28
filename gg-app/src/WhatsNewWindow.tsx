import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { theme } from "./theme";
import { recentChangelog } from "./changelog";
import { Confetti } from "./Confetti";
import { ShimmerText } from "./ShimmerText";

/**
 * Body of the dedicated, screen-centered "What's new" window (the borderless
 * Tauri window built by Rust `open_whatsnew_window`, reached via the
 * `?whatsnew=1` flag in main.tsx). Renders the most recent changelog bullets
 * (capped at 50, see `recentChangelog`) inside a scroll container that only
 * engages on overflow. Closing — Escape, the × button, or "Got it" — closes the
 * whole window.
 */
function closeSelf(): void {
  void getCurrentWebviewWindow()
    .close()
    .catch(() => {});
}

export function WhatsNewWindow(): React.ReactElement {
  // Escape closes the window (the borderless window has no native chrome).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeSelf();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const sections = recentChangelog(50);

  return (
    <div className="whatsnew-window" style={{ background: theme.surface2 }}>
      <Confetti />
      <div className="modal-head">
        <div className="modal-title">
          <ShimmerText base={theme.success} bright="#a7f3d0">
            What&apos;s new with GG Coder (last 50 updates)
          </ShimmerText>
        </div>
        <button
          className="modal-close"
          type="button"
          aria-label="Close"
          title="Close"
          onClick={closeSelf}
        >
          {"\u00d7"}
        </button>
      </div>
      <div className="whatsnew-scroll">
        {sections.map((section) => (
          <div key={section.version} className="whatsnew-section">
            <div className="whatsnew-version">{`v${section.version}`}</div>
            <ul className="whatsnew-list">
              {section.items.map((item, i) => (
                <li key={i} className="whatsnew-item">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="modal-btn primary" type="button" onClick={closeSelf}>
          Got it
        </button>
      </div>
    </div>
  );
}
