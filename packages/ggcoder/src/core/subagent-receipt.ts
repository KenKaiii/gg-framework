import path from "node:path";
import { editTargetPaths } from "../tools/edit-targets.js";

/**
 * Engine-generated receipt for a helper agent's report.
 *
 * The parent only ever saw a child's prose, and prose can cite files the child
 * never opened. The receipt is built from the child's real tool-call events, so
 * the model cannot write or forge it. It gives the parent checkable handles:
 * which files the child read or changed, which commands it ran and how they
 * exited, and which paths its report names that it never touched.
 */

/** Hard cap on the "Receipt (…)" line. */
export const RECEIPT_MAX_CHARS = 600;
/** Unbacked paths listed before "+N more". */
export const UNBACKED_MAX_PATHS = 5;
const TARGET_MAX_CHARS = 60;
const COMMAND_MAX_CHARS = 40;

export interface ReceiptCall {
  name: string;
  /** Raw key target (path / command / pattern / URL / agent), unshortened. */
  target: string;
  /** Search root for grep/find/ls/code_search, unresolved. */
  root?: string;
  outcome: "ok" | "error" | "pending";
  /** Parsed from bash's `Exit code: N` result prefix. */
  exitCode?: string;
}

const FILE_TOOLS = new Set(["read", "write", "edit"]);
const MUTATING_TOOLS = new Set(["write", "edit"]);
const ROOT_TOOLS = new Set(["grep", "find", "ls", "code_search"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The one argument that identifies what a tool call acted on. */
export function keyTarget(name: string, args: Record<string, unknown> = {}): string {
  switch (name) {
    case "edit":
      return editTargetPaths(args).join(",") || (str(args.path) ?? "");
    case "read":
    case "write":
      return str(args.file_path) ?? str(args.path) ?? "";
    case "ls":
      return str(args.path) ?? ".";
    case "grep":
    case "find":
      return str(args.pattern) ?? "";
    case "code_search":
    case "web_search":
      return str(args.query) ?? "";
    case "code_nav":
      return str(args.file) ?? "";
    case "bash":
      return (str(args.command) ?? "").split("\n")[0]!.trim();
    case "web_fetch":
      return str(args.url) ?? "";
    case "source_path":
      return str(args.package) ?? "";
    case "subagent":
    case "spawn_agent":
      if (Array.isArray(args.tasks)) return `${args.tasks.length} tasks`;
      return str(args.agent) ?? str(args.task_name) ?? "";
    case "task_output":
    case "task_stop":
    case "task_send":
      return str(args.id) ?? "";
    case "skill":
      return str(args.skill) ?? "";
    default: {
      const first = Object.values(args).find((value) => typeof value === "string" && value);
      return typeof first === "string" ? first.split("\n")[0]!.trim() : "";
    }
  }
}

function rootOf(name: string, args: Record<string, unknown>): string | undefined {
  if (!ROOT_TOOLS.has(name)) return undefined;
  return str(args.path) ?? ".";
}

/** Pairs tool_call_start/tool_call_end events by toolCallId. */
export class ReceiptRecorder {
  private calls: ReceiptCall[] = [];
  private readonly byId = new Map<string, ReceiptCall>();

  start(toolCallId: unknown, name: unknown, args: unknown): void {
    const toolName = typeof name === "string" && name ? name : "tool";
    const toolArgs = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const call: ReceiptCall = {
      name: toolName,
      target: keyTarget(toolName, toolArgs),
      root: rootOf(toolName, toolArgs),
      outcome: "pending",
    };
    this.calls.push(call);
    if (typeof toolCallId === "string" && toolCallId) this.byId.set(toolCallId, call);
  }

  end(toolCallId: unknown, result: unknown, isError: unknown): void {
    if (typeof toolCallId !== "string") return;
    const call = this.byId.get(toolCallId);
    if (!call) return;
    this.byId.delete(toolCallId);
    call.outcome = isError ? "error" : "ok";
    if (call.name === "bash" && typeof result === "string") {
      const match = /^Exit code: (\S+)/.exec(result);
      if (match) call.exitCode = match[1];
    }
  }

  reset(): void {
    this.calls = [];
    this.byId.clear();
  }

  snapshot(): ReceiptCall[] {
    return this.calls.map((call) => ({ ...call }));
  }

  /** Receipt + unbacked-path block for a finished report. */
  render(reportText: string, cwd: string): string {
    return buildHelperReceipt(this.calls, reportText, cwd);
  }
}

function displayPath(raw: string, cwd: string): string {
  let shown = raw;
  if (path.isAbsolute(raw)) {
    const relative = path.relative(cwd, raw);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) shown = relative;
  }
  shown = shown.split(path.sep).join("/");
  if (shown.length <= TARGET_MAX_CHARS) return shown;
  const parts = shown.split("/");
  const tail = `…/${parts.slice(-2).join("/")}`;
  return tail.length <= TARGET_MAX_CHARS ? tail : `…${shown.slice(-(TARGET_MAX_CHARS - 1))}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function renderTarget(call: ReceiptCall, cwd: string): string {
  const { name, target } = call;
  if (!target) return "";
  if (FILE_TOOLS.has(name) || name === "ls" || name === "code_nav") {
    return displayPath(target, cwd);
  }
  if (name === "bash") return `\`${clip(target, COMMAND_MAX_CHARS)}\``;
  if (name === "grep" || name === "find" || name === "code_search" || name === "web_search") {
    const root = call.root && call.root !== "." ? ` in ${displayPath(call.root, cwd)}` : "";
    return `"${clip(target, TARGET_MAX_CHARS - 2)}"${root}`;
  }
  return clip(target, TARGET_MAX_CHARS);
}

function renderOutcome(call: ReceiptCall): string {
  if (call.name === "bash" && call.exitCode !== undefined) return ` → exit ${call.exitCode}`;
  if (call.outcome === "error") return " ✗";
  if (call.outcome === "pending") return " (unfinished)";
  if (MUTATING_TOOLS.has(call.name)) return " ✓";
  return "";
}

/**
 * `Receipt (N calls): read a.ts, b.ts · bash \`npm test\` → exit 0 · edit b.ts ✓`
 * Groups by tool, collapses identical items as ×N, sorts tools and items
 * alphabetically, and caps the line at RECEIPT_MAX_CHARS with "+N more".
 */
export function formatReceipt(calls: readonly ReceiptCall[], cwd: string): string {
  const header = `Receipt (${calls.length} call${calls.length === 1 ? "" : "s"})`;
  if (calls.length === 0) return `${header}: no tool calls`;
  const groups = new Map<string, Map<string, number>>();
  for (const call of calls) {
    const item = `${renderTarget(call, cwd)}${renderOutcome(call)}`.trim();
    const group = groups.get(call.name) ?? new Map<string, number>();
    group.set(item, (group.get(item) ?? 0) + 1);
    groups.set(call.name, group);
  }
  const items: Array<{ tool: string; text: string }> = [];
  const byKey = <V>(a: [string, V], b: [string, V]): number =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  for (const [tool, group] of [...groups.entries()].sort(byKey)) {
    for (const [item, count] of [...group.entries()].sort(byKey)) {
      items.push({ tool, text: `${item}${count > 1 ? ` ×${count}` : ""}` });
    }
  }

  let line = `${header}:`;
  let lastTool: string | undefined;
  for (let index = 0; index < items.length; index++) {
    const { tool, text } = items[index]!;
    const piece =
      tool === lastTool
        ? `, ${text}`
        : `${lastTool === undefined ? " " : " · "}${tool}${text ? ` ${text}` : ""}`;
    const remaining = items.length - index - 1;
    // Reserve room for the "+N more" suffix unless this is the last item.
    const reserve = remaining > 0 ? ` · +${remaining} more`.length : 0;
    if (line.length + piece.length + reserve > RECEIPT_MAX_CHARS) {
      return `${line} · +${items.length - index} more`;
    }
    line += piece;
    lastTool = tool;
  }
  return line;
}

const PATH_EXTENSIONS =
  "tsx|ts|mts|cts|jsx|js|mjs|cjs|json|jsonc|md|mdx|py|go|rs|java|kt|kts|cs|rb|php|swift|" +
  "c|cc|cpp|h|hpp|m|sh|bash|zsh|ps1|yml|yaml|toml|ini|css|scss|sass|less|html|vue|svelte|" +
  "sql|graphql|proto|txt|lock|xml|gradle|env";
// A path-ish token: optional ./ ../ or / prefix, any directory segments, and a
// file name ending in a known source extension, optionally followed by
// :line[:col]. Lookbehind rejects mid-token starts (inside URLs, a.b.c chains).
const PATH_RE = new RegExp(
  `(?<![\\w@:/.\\\\-])((?:\\.{1,2}/|/)?(?:[\\w@.-]+/)*[\\w@-][\\w@.-]*\\.(?:${PATH_EXTENSIONS}))` +
    `(?::\\d+(?::\\d+)?)?(?![\\w/-])`,
  "g",
);
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** Prose names, not files: "Node.js", "Next.js", "Vue.js". */
const LIBRARY_NAME_RE = /^[A-Z][A-Za-z]*\.js$/;

/** Paths a report mentions, de-duplicated, without :line suffixes. */
export function extractReportPaths(reportText: string): string[] {
  const text = reportText.replace(URL_RE, " ");
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_RE)) {
    const candidate = match[1]!;
    if (LIBRARY_NAME_RE.test(candidate)) continue;
    if (/^\.+$/.test(candidate)) continue;
    found.add(candidate);
  }
  return [...found];
}

function isUnder(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix);
}

/**
 * Paths the report names that the helper never read, wrote, edited, listed or
 * searched. Conservative by design — anything plausibly touched is covered:
 * exact resolved match, inside a grep/find/ls/code_search root, or (for a
 * relative mention) the trailing segments of a touched file.
 */
export function findUnbackedPaths(
  reportText: string,
  calls: readonly ReceiptCall[],
  cwd: string,
): string[] {
  const files: string[] = [];
  const roots: string[] = [];
  for (const call of calls) {
    if (call.outcome === "error") continue;
    if ((FILE_TOOLS.has(call.name) || call.name === "code_nav") && call.target) {
      files.push(path.resolve(cwd, call.target));
    }
    if (call.root) roots.push(path.resolve(cwd, call.root));
  }
  const unbacked: string[] = [];
  for (const mention of extractReportPaths(reportText)) {
    const resolved = path.resolve(cwd, mention);
    if (files.includes(resolved)) continue;
    if (roots.some((root) => isUnder(resolved, root))) continue;
    if (!path.isAbsolute(mention)) {
      const suffix = `${path.sep}${path.normalize(mention).replace(/^(\.\.?[\\/])+/, "")}`;
      if (files.some((file) => file.endsWith(suffix))) continue;
    }
    unbacked.push(mention);
  }
  return unbacked.sort();
}

export function formatUnbacked(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const shown = paths.slice(0, UNBACKED_MAX_PATHS).join(", ");
  const more =
    paths.length > UNBACKED_MAX_PATHS ? `, +${paths.length - UNBACKED_MAX_PATHS} more` : "";
  return `Not opened by this helper: ${shown}${more}`;
}

/** Full receipt block appended to a helper's result. */
export function buildHelperReceipt(
  calls: readonly ReceiptCall[],
  reportText: string,
  cwd: string,
): string {
  const lines = [formatReceipt(calls, cwd)];
  const unbacked = formatUnbacked(findUnbackedPaths(reportText, calls, cwd));
  if (unbacked) lines.push(unbacked);
  return lines.join("\n");
}
