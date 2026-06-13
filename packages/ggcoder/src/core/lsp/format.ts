import type { LspDiagnostic } from "./client.js";

const SEVERITY_ERROR = 1;
const MAX_DIAGNOSTICS = 5;

/**
 * Render error-severity diagnostics for appending to an edit/write tool
 * result. Empty string when the file has no errors — clean edits stay
 * byte-identical to today's tool output.
 *
 * The header frames the list as informational so the model isn't baited into
 * premature fixes mid-way through a multi-file change (a cross-file error can
 * legitimately resolve once the related edit lands).
 */
export function formatDiagnostics(relPath: string, diagnostics: LspDiagnostic[]): string {
  const errors = diagnostics.filter((d) => (d.severity ?? SEVERITY_ERROR) === SEVERITY_ERROR);
  if (errors.length === 0) return "";

  const lines = errors.slice(0, MAX_DIAGNOSTICS).map((d) => {
    const line = d.range.start.line + 1;
    const character = d.range.start.character + 1;
    const message = d.message.split("\n")[0];
    const source = d.source ? ` (${d.source})` : "";
    return `L${line}:${character} ${message}${source}`;
  });
  const overflow =
    errors.length > MAX_DIAGNOSTICS
      ? `\n…and ${errors.length - MAX_DIAGNOSTICS} more error${errors.length - MAX_DIAGNOSTICS === 1 ? "" : "s"}`
      : "";

  return (
    `\n\nDiagnostics in ${relPath} (informational — may resolve after related edits):\n` +
    lines.join("\n") +
    overflow
  );
}
