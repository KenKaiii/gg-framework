import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { theme } from "./theme";
import { recentChangelog } from "./changelog";
import { Confetti } from "./Confetti";
import { ShimmerText } from "./ShimmerText";
import { Badge } from "./Badge";

/**
 * Body of the dedicated, screen-centered "What's new" window (the borderless
 * Tauri window built by Rust `open_whatsnew_window`, reached via the
 * `?whatsnew=1` flag in main.tsx). Renders the most recent changelog bullets
 * (capped at 50, see `recentChangelog`) inside a scroll container that only
 * engages on overflow. Closing — Escape, the × button, or "Got it" — closes the
 * whole window.
 */
const HIGHLIGHT_TERMS = [
  "MiMo-V2.5-Pro-UltraSpeed",
  "GPT-5.6 Ultra",
  "GPT-5.6",
  "GPT-5.5",
  "GPT-5.4 Mini",
  "GPT-5.4",
  "GPT-5.3 Codex",
  "Gemini 3.5 Flash",
  "Gemini 3.1 Pro",
  "Claude Sonnet 5",
  "Claude Fable 5",
  "Sakana Fugu",
  "Fugu Ultra",
  "Radio Paradise",
  "Kencode search",
  "Prompt Enhancer",
  "Send to GG Coder",
  "Grant Permissions",
  "Autopilot",
  "Scorecard",
  "Enhance",
  "@Ken",
  "Radio",
  "Windows",
  "Notes",
  "MCP",
] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const highlightPattern = new RegExp(
  `\`([^\`]+)\`|(${HIGHLIGHT_TERMS.map(escapeRegex).join("|")})|\\b(\\d+(?:\\.\\d+)?(?:K|M| MB| tokens?| minutes?| hour| updates?))\\b`,
  "g",
);

export function releaseText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(highlightPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const value = match[1] ?? match[2] ?? match[3] ?? match[0];
    nodes.push(
      <strong className="whatsnew-highlight" key={`${index}-${value}`}>
        {value}
      </strong>,
    );
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

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
          <ShimmerText base={theme.primary} bright={theme.secondary}>
            What&apos;s new with GG Coder
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
        {sections.map((section, sectionIndex) => (
          <div
            key={section.version}
            className={`whatsnew-section${sectionIndex === 0 ? " latest" : ""}`}
          >
            {sectionIndex === 1 && (
              <div className="whatsnew-history-divider">
                <span>Previous updates</span>
              </div>
            )}
            <div className="whatsnew-version">
              <span>{`v${section.version}`}</span>
              {sectionIndex === 0 && <Badge>Latest</Badge>}
            </div>
            <ul className="whatsnew-list">
              {section.items.map((item, i) => (
                <li key={i} className="whatsnew-item">
                  {releaseText(item)}
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
