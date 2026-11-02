import { formatElapsed } from "./ActivityBar";

/** Lines shown while a long output is folded: the end, where results are. */
export const SHELL_PREVIEW_LINES = 12;

/** Error output arrives wrapped in these (the sidecar's shell-runs.ts marks it). */
const STDERR_START = "\uE000";
const STDERR_END = "\uE001";

export type ShellSegment = { text: string; error: boolean };

/** Output from `from` on, split into normal and error runs. */
export function shellSegments(text: string, from = 0): ShellSegment[] {
  let error = false;
  for (let i = text.indexOf(STDERR_START); i !== -1 && i < from;) {
    const end = text.indexOf(STDERR_END, i);
    error = end === -1 || end >= from;
    i = text.indexOf(STDERR_START, end === -1 ? text.length : end);
  }
  const out: ShellSegment[] = [];
  let run = "";
  const push = (): void => {
    if (!run) return;
    const last = out[out.length - 1];
    if (last && last.error === error) last.text += run;
    else out.push({ text: run, error });
    run = "";
  };
  for (const ch of text.slice(from)) {
    if (ch === STDERR_START || ch === STDERR_END) {
      push();
      error = ch === STDERR_START;
    } else {
      run += ch;
    }
  }
  push();
  return out;
}

export function plainShellOutput(text: string): string {
  return text.replace(/[\uE000\uE001]/g, "");
}

export function formatShellDuration(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatElapsed(ms);
}

/**
 * Where the last `count` lines of `text` start, and how many lines it has in
 * all. A trailing newline (with any error marks around it) doesn't count.
 */
export function shellTail(
  text: string,
  count = SHELL_PREVIEW_LINES,
): { start: number; total: number } {
  const body = text.replace(/\n[\uE000\uE001]*$/, "");
  if (!plainShellOutput(body)) return { start: 0, total: 0 };
  let total = 1;
  for (let i = body.indexOf("\n"); i !== -1; i = body.indexOf("\n", i + 1)) total++;
  if (total <= count) return { start: 0, total };
  let start = body.length;
  for (let n = 0; n < count; n++) start = body.lastIndexOf("\n", start - 1);
  return { start: start + 1, total };
}

export function trimTrailingNewline(segments: ShellSegment[]): ShellSegment[] {
  const last = segments[segments.length - 1];
  if (!last?.text.endsWith("\n")) return segments;
  const text = last.text.slice(0, -1);
  return text ? [...segments.slice(0, -1), { ...last, text }] : segments.slice(0, -1);
}
