/**
 * Warnings for a background command whose output or exit code cannot tell the
 * agent what it is waiting to learn.
 *
 * A background task wakes a waiting agent in three ways: it exits, its output
 * matches the agent's wake pattern, or its output looks like a failure. Two
 * habits defeat all of them, and session logs showed both on most CI waits:
 *
 * - Redirecting stdout to /dev/null or a file. The task log never sees the
 *   lines, so no pattern or failure check can match them, and a failure that
 *   happens mid-run is only noticed at exit or when the wait runs out.
 * - `gh run watch` without `--exit-status`. It exits 0 when the run FAILS, so
 *   the exit looks like success.
 *
 * These are warnings, not refusals: a redirect is sometimes exactly what the
 * agent wants (a setup step whose output is noise).
 */

/** First words of commands whose redirect writes a file on purpose. */
const FILE_WRITERS = new Set([
  "cat",
  "echo",
  "printf",
  "tee",
  "true",
  ":",
  "mkdir",
  "touch",
  "git",
]);

/** Heredoc bodies hold arbitrary text (often code with `>` in it), never redirects. */
function stripHeredocs(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let terminator: string | null = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    kept.push(line);
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (heredoc?.[2]) terminator = heredoc[2];
  }
  return kept.join("\n");
}

/** Drop quoted strings and `$(...)` bodies, whose `>` is not this command's redirect. */
function stripNested(command: string): string {
  let text = command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // Innermost-first, bounded: nested substitutions are rare in a watch command.
  for (let i = 0; i < 5 && /\$\([^()]*\)/.test(text); i++) {
    text = text.replace(/\$\([^()]*\)/g, "$()");
  }
  return text;
}

/**
 * A stdout redirect: `>`, `>>`, `1>`, `&>`, `&>>` to a target. Not `2>` (stderr
 * only — stdout still reaches the log) and not `>&2` (still captured).
 */
const STDOUT_REDIRECT = /(?<![0-9<>&])(?:&>>?|1?>>?)\s*(?!&)([^\s;|&)]+)/;

export function backgroundWatchWarnings(command: string): string[] {
  const warnings: string[] = [];
  const shellText = stripNested(stripHeredocs(command));

  if (/\bgh\s+run\s+watch\b/.test(shellText) && !/--exit-status\b/.test(shellText)) {
    warnings.push(
      "`gh run watch` without --exit-status exits 0 even when the run fails, so its exit " +
        "code will look like success. Add --exit-status.",
    );
  }

  for (const segment of shellText.split(/\n|;|&&|\|\|/)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const firstWord = trimmed.split(/\s+/)[0] ?? "";
    if (FILE_WRITERS.has(firstWord)) continue;
    const redirect = STDOUT_REDIRECT.exec(trimmed);
    if (!redirect?.[1]) continue;
    const target = redirect[1];
    const where =
      target === "/dev/null"
        ? "discards its output"
        : /^[\w./~-]+$/.test(target)
          ? `writes its output to ${target}`
          : "writes its output to a file";
    // Quoted text and $(...) were blanked for detection; naming a mangled
    // segment back to the agent would only confuse it.
    const named = /''|""|\$\(\)/.test(trimmed)
      ? "A command here"
      : `\`${boundedSegment(trimmed)}\``;
    warnings.push(
      `${named} ${where}, so the task log cannot see it: no wake pattern ` +
        "or failure check can fire on those lines, and a mid-run failure is only noticed at " +
        "exit. If that is the output you are waiting on, drop the redirect — the task log " +
        "already keeps everything.",
    );
    break; // One redirect warning says it; more would only repeat it.
  }

  return warnings;
}

function boundedSegment(segment: string): string {
  const collapsed = segment.replace(/\s+/g, " ");
  return collapsed.length <= 80 ? collapsed : `${collapsed.slice(0, 79)}\u2026`;
}
