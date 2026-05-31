import { basename, plural, shortenValue } from "./tool-group-summary.js";
import { getToolTone, type ToolTone } from "./transcript/tool-presentation.js";

const MAX_DETAIL = 44;

/**
 * One styled fragment of a tool line. Colors are resolved by the renderer:
 * `tone` → the tool's accent color (bold verb), `dim` → muted summary text,
 * otherwise the default foreground (the detail).
 */
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

/** Present/past verb pairs keyed by tool name (mirrors the old tool headers). */
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
  enter_plan: { running: "Entering plan", done: "Entered plan" },
  exit_plan: { running: "Submitting plan", done: "Submitted plan" },
  "mcp__kencode-search__searchCode": { running: "Searching code", done: "Searched code" },
  "mcp__kencode-search__referenceSources": {
    running: "Finding references",
    done: "Found references",
  },
  "mcp__kencode-search__discoverRepos": { running: "Discovering repos", done: "Discovered repos" },
};

function humanizeName(name: string): VerbPair {
  const clean = name
    .replace(/^mcp__/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  const titled = clean.charAt(0).toUpperCase() + clean.slice(1);
  return { running: titled, done: titled };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return shortenValue(url, MAX_DETAIL);
  }
}

function firstLine(text: string): string {
  return shortenValue(text.split("\n")[0] ?? "", MAX_DETAIL);
}

/** The detail fragment (file, pattern, command, …). `quote` wraps it in quotes. */
function toolDetail(name: string, args: Record<string, unknown>): { text: string; quote: boolean } {
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return { text: basename(String(args.file_path ?? "")), quote: false };
    case "ls":
      return { text: shortenValue(String(args.path ?? "."), MAX_DETAIL), quote: false };
    case "grep":
    case "find":
      return { text: shortenValue(String(args.pattern ?? ""), MAX_DETAIL), quote: true };
    case "bash":
      return { text: firstLine(String(args.command ?? "")), quote: false };
    case "web_fetch":
      return { text: hostOf(String(args.url ?? "")), quote: false };
    case "web_search":
    case "mcp__kencode-search__searchCode":
      return { text: shortenValue(String(args.query ?? ""), MAX_DETAIL), quote: true };
    case "subagent":
      return { text: shortenValue(String(args.agent ?? ""), MAX_DETAIL), quote: false };
    case "skill":
      return { text: shortenValue(String(args.skill ?? ""), MAX_DETAIL), quote: false };
    case "source_path":
      return { text: shortenValue(String(args.package ?? ""), MAX_DETAIL), quote: false };
    default:
      return { text: "", quote: false };
  }
}

function countNonEmptyLines(result: string): number {
  return result.split("\n").filter((line) => line.length > 0).length;
}

/** The dim trailing summary, e.g. `42 lines`, `+12 −3`, `exit 0`, `3 matches`. */
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

interface ToolLineInput {
  done: boolean;
  isError?: boolean;
  result?: string;
  details?: unknown;
}

/**
 * Build the styled parts for one tool line (Example B):
 *   ● Read config.ts · 42 lines      (done)
 *   ◐ Running pnpm check…            (running)
 *
 * The verb is bold + tone-colored, the detail is plain foreground, and the
 * inline summary is dim. Error rows surface the first line of the result.
 */
export function buildToolLineParts(
  name: string,
  args: Record<string, unknown>,
  input: ToolLineInput,
): ToolLinePart[] {
  const verbs = VERBS[name] ?? humanizeName(name);
  const tone: ToolTone = getToolTone(name);
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
    if (summary) parts.push({ text: ` · ${summary}`, dim: true });
  } else {
    parts.push({ text: "\u2026" });
  }

  return parts;
}
