import type { McpServerRow } from "../agent";
import "./placeholder.css";

/** Most hidden-tool lines shown under a row; the rest are counted. */
const MAX_NOTE_LINES = 3;

/** The note lines for one server: its connect error, then each tool the guard hid. */
export function mcpRowNoteLines(server: McpServerRow): { text: string; attention: boolean }[] {
  const lines: { text: string; attention: boolean }[] = [];
  if (!server.ok && !server.requiresAuth && server.error) {
    const error = server.error.split("\n")[0] ?? "";
    lines.push({ text: error, attention: /^blocked/i.test(error) });
  }
  const hidden = (server.warning ?? "")
    .split("\n")
    .filter(Boolean)
    // The row already names the server.
    .map((line) => line.replace(` from server "${server.name}"`, ""));
  for (const line of hidden.slice(0, MAX_NOTE_LINES)) lines.push({ text: line, attention: true });
  if (hidden.length > MAX_NOTE_LINES) {
    lines.push({ text: `and ${hidden.length - MAX_NOTE_LINES} more hidden`, attention: false });
  }
  return lines;
}

/**
 * Placeholder (the fork owns the desktop design): why a server isn't fully
 * usable, under its row. The connect error (for example, blocked as malware),
 * and each tool the safety guard hid. Never a prompt.
 */
export function McpRowNotes({ server }: { server: McpServerRow }): React.ReactElement | null {
  const lines = mcpRowNoteLines(server);
  if (lines.length === 0) return null;
  return (
    <ul className="placeholder-list" aria-label={`Notes for ${server.name}`}>
      {lines.map((line, i) => (
        <li key={i} className={line.attention ? "placeholder-attention" : "placeholder-muted"}>
          {line.text}
        </li>
      ))}
    </ul>
  );
}
