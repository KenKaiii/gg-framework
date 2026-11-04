// Port of packages/ggcoder/src/ui/tool-line-summary.ts + tool-presentation.ts.
// Builds the same styled tool line the TUI shows:
//   ● Read App.tsx · 42 lines      (done)
//   ● Running pnpm check…          (running)
import { theme } from "./theme";

const MAX_DETAIL = 44;

export type ToolTone =
  "read" | "search" | "write" | "run" | "web" | "agent" | "state" | "source" | "default";

export interface ToolLinePart {
  text: string;
  bold?: boolean;
  tone?: ToolTone;
  dim?: boolean;
}

interface VerbPair {
  running: string;
  done: string;
}

const VERBS: Record<string, VerbPair> = {
  read: { running: "Reading", done: "Read" },
  ls: { running: "Listing", done: "Listed" },
  grep: { running: "Searching", done: "Searched" },
  find: { running: "Finding", done: "Found" },
  write: { running: "Writing", done: "Wrote" },
  edit: { running: "Updating", done: "Updated" },
  bash: { running: "Running", done: "Ran" },
  web_fetch: { running: "Fetching", done: "Fetched" },
  web_search: { running: "Searching web", done: "Searched web" },
  subagent: { running: "Delegating", done: "Delegated" },
  skill: { running: "Loading skill", done: "Loaded skill" },
  source_path: { running: "Resolving", done: "Resolved" },
  tasks: { running: "Updating tasks", done: "Updated tasks" },
  screenshot: { running: "Capturing", done: "Captured" },
  debug: { running: "Debugging", done: "Debugged" },
  enter_plan: { running: "Entering plan", done: "Entered plan" },
  exit_plan: { running: "Submitting plan", done: "Submitted plan" },
  steroids: { running: "Reading real code", done: "Read real code" },
};

function humanizeName(name: string): VerbPair {
  const clean = name
    .replace(/^mcp__/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  const titled = clean.charAt(0).toUpperCase() + clean.slice(1);
  return { running: titled, done: titled };
}

export function getToolTone(name: string): ToolTone {
  if (["read", "ls"].includes(name)) return "read";
  if (["grep", "find", "steroids"].includes(name)) return "search";
  if (["write", "edit"].includes(name)) return "write";
  if (["bash", "task_output", "task_stop", "debug"].includes(name)) return "run";
  if (["web_fetch", "web_search"].includes(name)) return "web";
  if (["subagent", "skill"].includes(name)) return "agent";
  if (["tasks"].includes(name)) return "state";
  if (["source_path"].includes(name)) return "source";
  if (name.startsWith("mcp__")) return "web";
  return "default";
}

/** Resolve a tone to the bold verb color (mirrors toolTonePalette `.primary`). */
export function toneColor(tone: ToolTone): string {
  switch (tone) {
    case "read":
      return theme.primary;
    case "search":
      return theme.secondary; // violet
    case "write":
      return theme.success;
    case "run":
      return theme.code; // amber
    case "web":
      return theme.language; // teal
    case "agent":
      return theme.primary;
    case "state":
      return theme.secondary;
    case "source":
      return theme.info;
    default:
      return theme.textSecondary;
  }
}

function shorten(value: string, max = MAX_DETAIL): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Last path segment, for BOTH separators. The webview has no `node:path`, and
 * splitting on "/" alone left every Windows path (`C:\repo\src\a.ts`) as one
 * segment — so tool rows showed the whole absolute path instead of the file
 * name.
 */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return shorten(url);
  }
}

function firstLine(text: string): string {
  return shorten(text.split("\n")[0] ?? "");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function toolDetail(name: string, args: Record<string, unknown>): { text: string; quote: boolean } {
  switch (name) {
    case "edit": {
      // A multi-file edit carries `files: [{ file_path, edits }]` instead of `file_path`.
      const paths = [
        args.file_path,
        ...(Array.isArray(args.files)
          ? args.files.map((f) => (f as { file_path?: unknown } | null)?.file_path)
          : []),
      ].filter((p): p is string => typeof p === "string" && p.length > 0);
      const first = paths[0] ?? "";
      const more = paths.length > 1 ? ` +${paths.length - 1} more` : "";
      return { text: `${basename(first)}${more}`, quote: false };
    }
    case "read":
    case "write":
      return { text: basename(String(args.file_path ?? "")), quote: false };
    case "ls":
      return { text: shorten(String(args.path ?? ".")), quote: false };
    case "grep":
    case "find":
      return { text: shorten(String(args.pattern ?? "")), quote: true };
    case "bash":
      return { text: firstLine(String(args.command ?? "")), quote: false };
    case "web_fetch":
      return { text: hostOf(String(args.url ?? "")), quote: false };
    case "web_search":
      return { text: shorten(String(args.query ?? "")), quote: true };
    case "steroids":
      return {
        text: shorten(
          Array.isArray(args.repos)
            ? args.repos.map(String).join(", ")
            : String(args.pattern ?? args.symbol ?? args.query ?? args.path ?? args.repo ?? ""),
        ),
        quote: true,
      };
    case "subagent":
      return { text: shorten(String(args.agent ?? "")), quote: false };
    case "skill":
      return { text: shorten(String(args.skill ?? "")), quote: false };
    case "source_path":
      return { text: shorten(String(args.package ?? "")), quote: false };
    case "debug": {
      // "launch src/app.js", "evaluate user.id", "step_over".
      const target = args.program ?? args.expression ?? args.breakpoint_id ?? args.file;
      return {
        text: shorten(`${String(args.action ?? "")}${target ? ` ${String(target)}` : ""}`),
        quote: false,
      };
    }
    default:
      return { text: "", quote: false };
  }
}

function countNonEmptyLines(result: string): number {
  return result.split("\n").filter((line) => line.length > 0).length;
}

function inlineSummary(name: string, result: string, details: unknown): string {
  if (!result) return "";
  switch (name) {
    case "read":
    case "web_fetch": {
      if (result.startsWith("Error")) return "";
      const n = countNonEmptyLines(result);
      return `${n} ${plural(n, "line")}`;
    }
    case "write": {
      const m = result.match(/Wrote (\d+) lines?/);
      return m ? `${m[1]} ${plural(Number(m[1]), "line")}` : "";
    }
    case "edit": {
      const diff = (details as { diff?: string } | undefined)?.diff ?? result;
      const added = (diff.match(/^\+[^+]/gm) ?? []).length;
      const removed = (diff.match(/^-[^-]/gm) ?? []).length;
      return added > 0 || removed > 0 ? `+${added} \u2212${removed}` : "";
    }
    case "bash": {
      const exit = result.match(/Exit code: (\S+)/)?.[1];
      return exit ? `exit ${exit}` : "";
    }
    case "grep": {
      const matches = result
        .split("\n")
        .filter((line) => line.length > 0 && !/^\d+ match|^\[Truncated/.test(line)).length;
      return matches > 0 ? `${matches} ${plural(matches, "match", "matches")}` : "";
    }
    case "find": {
      const n = countNonEmptyLines(result);
      return `${n} ${plural(n, "file")}`;
    }
    case "ls": {
      const n = countNonEmptyLines(result);
      return `${n} ${plural(n, "item")}`;
    }
    default:
      return "";
  }
}

/**
 * A tool line from the tool's name and a one-line summary of its args, for a
 * call known only by that summary (a group member's turn, as the host reports it).
 */
export function buildSummaryLineParts(
  name: string,
  summary: string,
  done: boolean,
): ToolLinePart[] {
  const verbs = VERBS[name] ?? humanizeName(name);
  const parts: ToolLinePart[] = [
    { text: done ? verbs.done : verbs.running, bold: true, tone: getToolTone(name) },
  ];
  if (summary) parts.push({ text: ` ${summary}` });
  if (!done) parts.push({ text: "\u2026" });
  return parts;
}

export function buildToolLineParts(
  name: string,
  args: Record<string, unknown>,
  input: { done: boolean; isError?: boolean; result?: string; details?: unknown },
): ToolLinePart[] {
  const indexing =
    name === "steroids" &&
    (args.action === "add" || (args.action === "discover" && args.add === true));
  const verbs = indexing
    ? { running: "Indexing repos", done: "Indexed repos" }
    : (VERBS[name] ?? humanizeName(name));
  const tone = getToolTone(name);
  const verb = input.done ? verbs.done : verbs.running;
  const { text: detail, quote } = toolDetail(name, args);

  const parts: ToolLinePart[] = [{ text: verb, bold: true, tone }];
  if (detail) {
    parts.push({ text: ` ${quote ? `"${detail}"` : detail}` });
  }
  if (input.done) {
    const summary = input.isError
      ? firstLine(input.result ?? "")
      : inlineSummary(name, input.result ?? "", input.details);
    if (summary) parts.push({ text: ` \u00b7 ${summary}`, dim: true });
  } else {
    parts.push({ text: "\u2026" });
  }
  return parts;
}
