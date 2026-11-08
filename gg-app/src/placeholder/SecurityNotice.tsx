import { safetyRuleReason } from "../tool-format";
import "./placeholder.css";

/** The row's wording: what happened, in plain words, then what it was about. */
export function describeSecurityBlock(rule: string, target: string, count = 1): string {
  const lead =
    rule === "installed-malware"
      ? "Infected package in this project, replacing it"
      : `Blocked for safety: ${safetyRuleReason(rule)}`;
  const text = target ? `${lead} \u00b7 ${target}` : lead;
  return count > 1 ? `${text} \u00d7${count}` : text;
}

/**
 * Placeholder (the fork owns the desktop design): the chat row a safety block
 * leaves behind. It never asks anything; it's the lasting record of what was
 * stopped.
 */
export function SecurityNotice({
  rule,
  target,
  count,
}: {
  rule: string;
  target: string;
  count?: number;
}): React.ReactElement {
  return (
    <div className="placeholder-notice" role="note">
      <p className="placeholder-notice-body placeholder-attention">
        {describeSecurityBlock(rule, target, count)}
      </p>
    </div>
  );
}
