import type { CSSProperties } from "react";
import type { ChangelogEntry } from "./changelog";
import { PlateButton } from "./PlateButton";
import { shortDate, splitItem, type WhatsNewMode } from "./whatsnew-content";

/** What the lounge design receives from the window shell. */
export interface LoungeProps {
  /** The release that just arrived: the star of the show. */
  latest: ChangelogEntry;
  /** Older releases, shown as a calm history list. */
  earlier: readonly ChangelogEntry[];
  mode: WhatsNewMode;
  onClose: () => void;
}

/**
 * Building blocks of the "What's new" window: highlighted release
 * text, the headline + body split, and the quiet history list
 * the window ends with.
 */
const HIGHLIGHT_TERMS = [
  "MiMo-V2.5-Pro-UltraSpeed",
  "GPT-6 Astra",
  "GPT-6.1 Sol",
  "GPT-6 Sol",
  "GPT-6 Luna",
  "GPT-5.6 Ultra",
  "GPT-5.6",
  "GPT-5.5",
  "GPT-5.4 Mini",
  "GPT-5.4",
  "GPT-5.3 Codex",
  "Gemini 3.5 Flash",
  "Gemini 3.1 Pro",
  "Claude Sonnet 5",
  "Claude Fable 5.1",
  "Claude Fable 5",
  "Sakana Fugu",
  "Fugu Ultra",
  "Radio Paradise",
  "Steroids",
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

/** Release copy with backticked names and known specifics highlighted. */
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

/** A bullet read as a headline (its hook sentence) over the detail. */
export function FeatureCopy({
  item,
  as: Heading = "h3",
}: {
  item: string;
  as?: "h1" | "h2" | "h3" | "h4";
}): React.ReactElement {
  const { headline, body } = splitItem(item);
  return (
    <>
      <Heading className="wn-headline">{releaseText(headline)}</Heading>
      {body && <p className="wn-body">{releaseText(body)}</p>}
    </>
  );
}

/**
 * The window always ends the same way: the older releases as a calm, scannable
 * list. The spectacle is for what just arrived, not the archive.
 */
export function ReleaseHistory({
  sections,
  title = "Earlier updates",
  delay = 0,
}: {
  sections: readonly ChangelogEntry[];
  title?: string;
  /** Row index to enter at in hype mode, so the archive follows the new features. */
  delay?: number;
}): React.ReactElement | null {
  if (sections.length === 0) return null;
  return (
    <section
      className="wn-history wn-row-in"
      aria-label={title}
      style={{ "--i": delay } as CSSProperties}
    >
      <h2 className="wn-history-title">
        <span>{title}</span>
      </h2>
      {sections.map((section) => (
        <div className="wn-history-release" key={section.version}>
          <h3 className="wn-history-version">
            <span>{`v${section.version}`}</span>
            <time dateTime={section.date}>{shortDate(section.date)}</time>
          </h3>
          <ul className="wn-history-list">
            {section.items.map((item, i) => (
              <li key={i} className="wn-history-item">
                <FeatureCopy item={item} as="h4" />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** The footer's one action, GG Royale's plate. Not focused on open (no ring); the window closes on Enter. */
export function DoneButton({
  label,
  onClose,
}: {
  label: string;
  onClose: () => void;
}): React.ReactElement {
  return <PlateButton className="wn-done" label={label} onClick={onClose} />;
}
