import React, { memo } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { Spinner } from "./Spinner.js";
import { ToolUseLoader } from "./ToolUseLoader.js";
import { MessageResponse } from "./MessageResponse.js";
import { highlightCode, langFromPath } from "../utils/highlight.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { computeWordDiff, type WordSegment } from "../utils/word-diff.js";
import { DiffFrame } from "./DiffFrame.js";
import { NoSelect } from "./NoSelect.js";
import { toolAccentColor, toolNameColor } from "../transcript/tool-presentation.js";

const MAX_OUTPUT_LINES = 4; // max lines shown per tool result
const RESPONSE_LEFT_PADDING = 1;

// ToolUseLoader minWidth={2} = 2 chars
const HEADER_PREFIX = 2;
// MessageResponse gutter: "  ⎿  " = 6 chars
const BODY_PREFIX = 6;

/** Truncate a line so it fits within ~1 terminal row. */
function truncateLine(line: string, cols: number, reservedChars = 6): string {
  const max = cols - reservedChars;
  return line.length > max ? line.slice(0, max) + "…" : line;
}

/**
 * Optional formatter that downstream consumers (e.g. gg-editor) can pass to
 * customise the per-tool header and inline summary without forking this
 * component. Each fn returns `undefined` to fall back to the built-in
 * behaviour. Same shape applies to running + done states.
 */
/** Inline summary is either plain text (uses textDim) or styled with a hex color. */
export type InlineSummary = string | { text: string; color: string };

export interface ToolExecutionFormatters {
  /** Override the bold tool label, e.g. "Cut Filler Words". */
  formatLabel?: (name: string, args: Record<string, unknown>) => string | undefined;
  /** Override the parenthetical detail, e.g. `"transcript.json"` → `Cut Filler Words(transcript.json)`. */
  formatDetail?: (name: string, args: Record<string, unknown>) => string | undefined;
  /**
   * Override the inline summary at done time. Return a string for the default
   * dim color, or `{ text, color }` to render in a custom color (e.g. gg-boss
   * uses this to randomise the "dispatched" color per call).
   */
  formatInline?: (name: string, result: string, isError: boolean) => InlineSummary | undefined;
}

interface ToolRunningProps {
  status: "running";
  name: string;
  args: Record<string, unknown>;
  /** Live progress output (e.g., bash streaming stdout). */
  progressOutput?: string;
  /** Animate the running indicator until this timestamp, then settle static. */
  animateUntil?: number;
  formatters?: ToolExecutionFormatters;
  marginTop?: number;
}

interface ToolDoneProps {
  status: "done";
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  details?: unknown;
  formatters?: ToolExecutionFormatters;
  marginTop?: number;
}

type ToolExecutionProps = ToolRunningProps | ToolDoneProps;

/** Tools that use compact one-line summaries instead of showing output. */
const COMPACT_TOOLS = new Set(["read", "grep", "find", "ls", "source_path"]);
const STATE_TOOLS = new Set(["tasks", "goals"]);

/** Tools rendered with the server-tool style (spinner + summary, no output). */
const SERVER_STYLE_TOOLS = new Set(["web_search"]);

export function ToolExecution(props: ToolExecutionProps) {
  const theme = useTheme();
  const { columns } = useTerminalSize();
  const staticDisplay = props.status === "running" ? false : true;
  const marginTop = props.marginTop ?? 0;

  if (props.status === "running") {
    // Server-style tools (web_search) — blinking dot + spinner "Searching..."
    if (SERVER_STYLE_TOOLS.has(props.name)) {
      const { label, detail } = applyFormatters(
        getToolHeaderParts(props.name, props.args),
        props.name,
        props.args,
        props.formatters,
      );
      const headerContentWidth = Math.max(10, columns - HEADER_PREFIX);
      return (
        <Box flexDirection="column" paddingLeft={RESPONSE_LEFT_PADDING} marginTop={marginTop}>
          <Box flexDirection="row">
            <Box width={HEADER_PREFIX} flexShrink={0}>
              <Spinner staticDisplay={staticDisplay} />
            </Box>
            <Box flexGrow={1} width={headerContentWidth}>
              <Text wrap="wrap">
                <Text bold color={theme.toolName}>
                  {label}
                </Text>
                {detail && (
                  <Text color={theme.text}>
                    {"("}
                    <Text color={theme.textDim}>{'"'}</Text>
                    {detail}
                    <Text color={theme.textDim}>{'"'}</Text>
                    {")"}
                  </Text>
                )}
              </Text>
            </Box>
          </Box>
          <MessageResponse>
            <Text color={theme.textDim} wrap="wrap">
              Searching...
            </Text>
          </MessageResponse>
        </Box>
      );
    }
    // Compact tools get a blinking dot + summary label
    if (COMPACT_TOOLS.has(props.name)) {
      const summary = getCompactRunningLabel(props.name, props.args);
      return (
        <Box paddingLeft={RESPONSE_LEFT_PADDING} marginTop={marginTop} flexDirection="row">
          <Box width={HEADER_PREFIX} flexShrink={0}>
            <Spinner staticDisplay={staticDisplay} />
          </Box>
          <Text color={toolNameColor(theme, props.name)} bold>
            {summary}
          </Text>
        </Box>
      );
    }
    if (STATE_TOOLS.has(props.name)) {
      const { label, detail } = getToolHeaderParts(props.name, props.args);
      return (
        <Box paddingLeft={RESPONSE_LEFT_PADDING} marginTop={marginTop} flexDirection="row">
          <Box width={HEADER_PREFIX} flexShrink={0}>
            <Spinner staticDisplay={staticDisplay} />
          </Box>
          <Text color={toolNameColor(theme, props.name)} bold>
            {label}
          </Text>
          {detail ? <Text color={theme.textDim}> {detail}</Text> : null}
        </Box>
      );
    }

    // Non-compact tools keep the same status-dot header spacing as completed rows.
    const { label, detail } = getToolHeaderParts(props.name, props.args);

    // Bash progress streaming — show last 3 lines of live output
    if (props.name === "bash" && props.progressOutput) {
      const progLines = props.progressOutput.split("\n").filter(Boolean);
      const tail = progLines.slice(-3);
      return (
        <Box paddingLeft={RESPONSE_LEFT_PADDING} flexDirection="column">
          <Box flexDirection="row">
            <Box width={HEADER_PREFIX} flexShrink={0}>
              <Spinner staticDisplay={staticDisplay} />
            </Box>
            <Text color={theme.toolName} bold wrap="wrap">
              {detail ? `${label}(${detail})` : label}
            </Text>
          </Box>
          <MessageResponse>
            <Box flexDirection="column">
              {tail.map((line, i) => (
                <Text key={i} color={theme.textDim} wrap="truncate">
                  {truncateLine(line, columns - 8)}
                </Text>
              ))}
            </Box>
          </MessageResponse>
        </Box>
      );
    }

    return (
      <Box paddingLeft={RESPONSE_LEFT_PADDING} marginTop={marginTop} flexDirection="row">
        <Box width={HEADER_PREFIX} flexShrink={0}>
          <Spinner staticDisplay={staticDisplay} />
        </Box>
        <Text color={toolNameColor(theme, props.name)} bold wrap="wrap">
          {detail ? `${label}(${detail})` : label}
        </Text>
      </Box>
    );
  }

  const { name, args, result, isError, details } = props;
  const headerContentWidth = Math.max(10, columns - HEADER_PREFIX);
  const bodyContentWidth = Math.max(10, columns - BODY_PREFIX);

  // Server-style tools (web_search) — match ServerToolExecution done display
  if (SERVER_STYLE_TOOLS.has(name)) {
    const { label, detail } = applyFormatters(
      getToolHeaderParts(name, args),
      name,
      args,
      props.formatters,
    );
    const searchCount = (result.match(/^\d+\./gm) ?? []).length;
    const summaryText = isError
      ? result.split("\n")[0]
      : `${searchCount} result${searchCount !== 1 ? "s" : ""}`;
    return (
      <Box flexDirection="column" paddingLeft={RESPONSE_LEFT_PADDING} marginTop={marginTop}>
        <Box flexDirection="row">
          <ToolUseLoader status={isError ? "error" : "done"} />
          <Box flexGrow={1} width={headerContentWidth}>
            <Text wrap="wrap">
              <Text bold color={isError ? theme.error : toolNameColor(theme, name)}>
                {label}
              </Text>
              {detail && (
                <Text color={theme.text}>
                  {"("}
                  <Text color={theme.textDim}>{'"'}</Text>
                  {detail}
                  <Text color={theme.textDim}>{'"'}</Text>
                  {")"}
                </Text>
              )}
            </Text>
          </Box>
        </Box>
        <MessageResponse>
          <Text color={theme.textDim} wrap="wrap">
            {summaryText}
          </Text>
        </MessageResponse>
      </Box>
    );
  }

  // Compact tools — one-line summary, no output content
  if (COMPACT_TOOLS.has(name) && !isError) {
    const summary = getCompactDoneLabel(name, args, result);
    return (
      <Box paddingLeft={RESPONSE_LEFT_PADDING} marginTop={marginTop} flexDirection="row">
        <ToolUseLoader status="done" />
        <Box flexGrow={1} width={headerContentWidth}>
          <Text bold color={toolNameColor(theme, name)} wrap="wrap">
            {summary}
          </Text>
        </Box>
      </Box>
    );
  }

  if (STATE_TOOLS.has(name)) {
    const { label, detail } = getToolHeaderParts(name, args);
    const inline = getInlineSummary(name, result, isError);
    return (
      <Box paddingLeft={RESPONSE_LEFT_PADDING} marginTop={marginTop} flexDirection="row">
        <ToolUseLoader status={isError ? "error" : "done"} />
        <Box flexGrow={1} width={headerContentWidth}>
          <Text wrap="wrap">
            <Text bold color={isError ? theme.error : toolNameColor(theme, name)}>
              {label}
            </Text>
            {detail ? <Text color={theme.textDim}> {detail}</Text> : null}
            {inline ? <Text color={theme.textDim}> · {inline}</Text> : null}
          </Text>
        </Box>
      </Box>
    );
  }

  // Extract diff from details (structured result) or fall back to result string
  const editDetails = details as { diff?: string } | undefined;
  const diffText = editDetails?.diff ?? (result.includes("---") ? result : undefined);
  const isDiff = name === "edit" && !isError && !!diffText;

  const { label, detail } = applyFormatters(
    getToolHeaderParts(name, args),
    name,
    args,
    props.formatters,
  );
  const body = isDiff
    ? buildDiffBody(diffText!, args, columns)
    : buildResultBody(name, result, isError, columns);

  const headerColor = isError ? theme.error : toolNameColor(theme, name);

  // Compact display — no body to show, but show inline summary
  if (!body) {
    const inline =
      props.formatters?.formatInline?.(name, result, isError) ??
      getInlineSummary(name, result, isError);
    const inlineText = typeof inline === "string" ? inline : inline?.text;
    const inlineColor =
      inline && typeof inline === "object" ? inline.color : toolAccentColor(theme, name);
    return (
      <Box paddingLeft={RESPONSE_LEFT_PADDING} marginTop={marginTop} flexDirection="row">
        <ToolUseLoader status={isError ? "error" : "done"} />
        <Box flexGrow={1} width={headerContentWidth}>
          <Text wrap="wrap">
            <Text bold color={headerColor}>
              {label}
            </Text>
            {detail && (
              <Text color={theme.text}>
                {"("}
                {detail}
                {")"}
              </Text>
            )}
            {inlineText && <Text color={inlineColor}> {inlineText}</Text>}
          </Text>
        </Box>
      </Box>
    );
  }

  const { lines, totalLines } = body;
  const hiddenCount = totalLines - lines.length;

  return (
    <Box flexDirection="column" paddingLeft={RESPONSE_LEFT_PADDING} marginTop={marginTop}>
      {/* Header: status dot + wrapping content */}
      <Box flexDirection="row">
        <ToolUseLoader status={isError ? "error" : "done"} />
        <Box flexGrow={1} width={headerContentWidth}>
          <Text wrap="wrap">
            <Text bold color={headerColor}>
              {label}
            </Text>
            {detail && (
              <Text color={theme.text}>
                {"("}
                {detail}
                {")"}
              </Text>
            )}
          </Text>
        </Box>
      </Box>
      {/* Body with ⎿ bracket via MessageResponse */}
      <MessageResponse>
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Box key={i} flexGrow={1} width={bodyContentWidth}>
              {line}
            </Box>
          ))}
          {hiddenCount > 0 && (
            <Text color={theme.textDim} wrap="wrap">
              {"… +"}
              {hiddenCount}
              {" lines"}
            </Text>
          )}
        </Box>
      </MessageResponse>
    </Box>
  );
}

// ── Compact tool labels ─────────────────────────────────────

function getCompactRunningLabel(name: string, _args: Record<string, unknown>): string {
  switch (name) {
    case "grep":
      return "Searching…";
    case "read":
      return "Reading…";
    case "find":
      return "Finding files…";
    case "ls":
      return "Listing…";
    case "source_path": {
      const packageName = String(_args.package ?? "");
      const suffix = packageName ? ` for ${packageName}` : "";
      return `Resolving source${suffix}…`;
    }
    default:
      return `${name}…`;
  }
}

function getCompactDoneLabel(name: string, args: Record<string, unknown>, result: string): string {
  switch (name) {
    case "grep": {
      const lines = result.split("\n").filter((l) => l.length > 0);
      // Filter out the summary line ("N match(es) found" or "[Truncated at N matches]")
      const matchCount = lines.filter((l) => !l.match(/^\d+ match|^\[Truncated/)).length;
      return `Searched for 1 pattern${matchCount > 0 ? ` (${matchCount} match${matchCount !== 1 ? "es" : ""})` : ""}`;
    }
    case "read": {
      const filePath = String(args.file_path ?? "");
      const shortPath = shortenPath(filePath);
      return `Read ${shortPath}`;
    }
    case "find": {
      const lines = result.split("\n").filter((l) => l.length > 0);
      return `Found ${lines.length} file${lines.length !== 1 ? "s" : ""}`;
    }
    case "ls": {
      const lines = result.split("\n").filter((l) => l.length > 0);
      return `Listed ${lines.length} item${lines.length !== 1 ? "s" : ""}`;
    }
    case "source_path": {
      const packageName = String(args.package ?? "source");
      const sourcePath = extractSourcePath(result);
      const shortSourcePath = sourcePath ? shortenPath(sourcePath) : "source path";
      return `Resolved ${packageName} → ${shortSourcePath}`;
    }
    default:
      return name;
  }
}

// ── Header formatting ──────────────────────────────────────

function shortenPath(filePath: string): string {
  // Show last 2 path segments max, e.g. "src/components/App.tsx"
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return "…/" + parts.slice(-2).join("/");
}

function extractSourcePath(result: string): string | undefined {
  return result.match(/^Source path:\s*(.+)$/m)?.[1]?.trim();
}

function getToolHeaderParts(
  name: string,
  args: Record<string, unknown>,
): { label: string; detail: string } {
  const displayName = toolDisplayName(name);
  switch (name) {
    case "bash": {
      const cmd = String(args.command ?? "");
      const firstLine = cmd.split("\n")[0];
      const truncCmd = firstLine.length > 60 ? firstLine.slice(0, 57) + "…" : firstLine;
      const multiline = cmd.includes("\n");
      return { label: displayName, detail: `${truncCmd}${multiline ? " …" : ""}` };
    }
    case "edit":
      return { label: displayName, detail: shortenPath(String(args.file_path ?? "")) };
    case "write":
      return { label: displayName, detail: shortenPath(String(args.file_path ?? "")) };
    case "read":
      return { label: "Read", detail: shortenPath(String(args.file_path ?? "")) };
    case "grep": {
      const pat = String(args.pattern ?? "");
      return { label: displayName, detail: pat.length > 40 ? pat.slice(0, 37) + "…" : pat };
    }
    case "find": {
      const pat = String(args.pattern ?? "");
      return { label: displayName, detail: pat.length > 40 ? pat.slice(0, 37) + "…" : pat };
    }
    case "ls":
      return { label: displayName, detail: shortenPath(String(args.path ?? ".")) };
    case "subagent": {
      const task = String(args.task ?? "");
      const trunc = task.length > 50 ? task.slice(0, 47) + "…" : task;
      return { label: displayName, detail: trunc };
    }
    case "skill": {
      const skillName = String(args.skill ?? "");
      return { label: displayName, detail: skillName };
    }
    case "task_output":
      return { label: displayName, detail: String(args.id ?? "") };
    case "task_stop":
      return { label: displayName, detail: String(args.id ?? "") };
    case "web_search": {
      const query = String(args.query ?? "");
      const trunc = query.length > 60 ? query.slice(0, 57) + "…" : query;
      return { label: "Web Search", detail: trunc };
    }
    case "source_path": {
      const packageName = String(args.package ?? "");
      const trunc = packageName.length > 60 ? packageName.slice(0, 57) + "…" : packageName;
      return { label: displayName, detail: trunc };
    }
    case "web_fetch": {
      const url = String(args.url ?? "");
      const trunc = url.length > 60 ? url.slice(0, 57) + "…" : url;
      return { label: displayName, detail: trunc };
    }
    case "tasks": {
      const action = String(args.action ?? "");
      return { label: displayName, detail: action };
    }
    case "goals": {
      const action = String(args.action ?? "");
      return { label: displayName, detail: action };
    }
    default: {
      if (name.startsWith("mcp__")) {
        // Pick the most meaningful arg as the detail (skip long blobs)
        const detail = getMCPDetailArg(args);
        return { label: displayName, detail };
      }
      return { label: displayName, detail: "" };
    }
  }
}

function toolDisplayName(name: string): string {
  if (name.startsWith("mcp__")) {
    // mcp__kencode-search__searchCode → "searchCode"
    // mcp__zai_vision__analyze_image → "analyze_image"
    const parts = name.split("__");
    const toolFn = parts[2] ?? parts[1] ?? "mcp";
    return snakeToTitle(toolFn);
  }
  switch (name) {
    case "bash":
      return "Bash";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
      return "Update";
    case "grep":
      return "Search";
    case "find":
      return "Find";
    case "ls":
      return "List";
    case "subagent":
      return "Agent";
    case "skill":
      return "Skill";
    case "web_fetch":
      return "Fetch";
    case "web_search":
      return "Web Search";
    case "task_output":
      return "Task Output";
    case "task_stop":
      return "Task Stop";
    case "source_path":
      return "Source";
    case "tasks":
      return "Task";
    case "goals":
      return "Goal";
    default:
      // snake_case → Title Case so downstream consumers (gg-editor's 91 tools,
      // future MCP tools, custom tools) get readable names without each
      // having to add an explicit case here. Includes camelCase split too
      // so `cutFillerWords` also formats cleanly.
      return snakeToTitle(name);
  }
}

/**
 * Convert `snake_case` or `camelCase` to `Title Case`.
 *   read_skill         → Read Skill
 *   cut_filler_words   → Cut Filler Words
 *   analyzeHook        → Analyze Hook
 */
function snakeToTitle(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // camelCase → snake_case bridge
    .split("_")
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Apply consumer-supplied formatter overrides on top of the built-in header
 * parts. Returns a fresh `{label, detail}` with overrides applied.
 *
 * Each override is opt-in: returning `undefined` means "use the built-in."
 * Empty-string is a meaningful override ("hide the detail").
 */
function applyFormatters(
  builtin: { label: string; detail: string },
  name: string,
  args: Record<string, unknown>,
  formatters?: ToolExecutionFormatters,
): { label: string; detail: string } {
  if (!formatters) return builtin;
  const label = formatters.formatLabel?.(name, args);
  const detail = formatters.formatDetail?.(name, args);
  return {
    label: label !== undefined ? label : builtin.label,
    detail: detail !== undefined ? detail : builtin.detail,
  };
}

// ── MCP detail arg extraction ─────────────────────────────

/** Pick the single most meaningful arg for the MCP tool header. */
function getMCPDetailArg(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return "";

  // Prefer short, descriptive keys over long blobs
  const preferred = ["query", "prompt", "url", "path", "pattern", "name", "command", "repo"];
  let best: [string, unknown] | undefined;
  for (const key of preferred) {
    const found = entries.find(([k]) => k.toLowerCase() === key);
    if (found) {
      best = found;
      break;
    }
  }
  // Fall back to shortest non-path string arg
  if (!best) {
    best = entries
      .filter(([, v]) => typeof v === "string")
      .sort((a, b) => String(a[1]).length - String(b[1]).length)[0];
  }
  if (!best) best = entries[0];

  const val = String(best[1]);
  const truncated = val.length > 50 ? val.slice(0, 47) + "…" : val;
  return truncated;
}

// ── Inline summary for compact tools ───────────────────────

function getInlineSummary(name: string, result: string, isError: boolean): string {
  if (isError) {
    const firstLine = result.split("\n")[0];
    return firstLine.length > 60 ? firstLine.slice(0, 57) + "…" : firstLine;
  }
  switch (name) {
    case "read": {
      const lines = result.split("\n").filter((l) => l.length > 0);
      return `${lines.length} line${lines.length !== 1 ? "s" : ""}`;
    }
    case "write": {
      const match = result.match(/^Wrote \d+ lines?/);
      return match ? match[0] : result.split("\n")[0];
    }
    case "bash": {
      const match = result.match(/^Exit code: (.+)/);
      return match ? `exit ${match[1]}` : "done";
    }
    case "subagent":
      return "completed";
    case "skill":
      return result.startsWith("Error") ? result.split("\n")[0] : "loaded";
    case "web_fetch": {
      const lines = result.split("\n").filter((l) => l.length > 0);
      if (result.startsWith("Error")) return result.split("\n")[0];
      return `${lines.length} line${lines.length !== 1 ? "s" : ""}`;
    }
    case "source_path": {
      const sourcePath = extractSourcePath(result);
      return sourcePath ? shortenPath(sourcePath) : "resolved";
    }
    case "task_stop":
      return result.split("\n")[0] || "stopped";
    case "tasks": {
      // Extract just the task text from results like 'Task added: "Fix bug" (id: abc…)'
      const quoted = result.match(/"([^"]+)"/);
      if (quoted) {
        const text = quoted[1];
        return text.length > 50 ? text.slice(0, 47) + "…" : text;
      }
      return result.split("\n")[0];
    }
    case "goals": {
      const quoted = result.match(/"([^"]+)"/);
      if (quoted) {
        const text = quoted[1];
        return text.length > 50 ? text.slice(0, 47) + "…" : text;
      }
      const firstLine = result.split("\n")[0] ?? "";
      return firstLine.length > 60 ? firstLine.slice(0, 57) + "…" : firstLine;
    }
    default: {
      if (name.startsWith("mcp__")) {
        const lines = result.split("\n").filter((l) => l.length > 0);
        if (lines.length === 0) return "no results";
        // Show first meaningful line as summary for compact display
        const first = lines[0].length > 50 ? lines[0].slice(0, 47) + "…" : lines[0];
        return lines.length === 1 ? first : `${lines.length} lines`;
      }
      return "";
    }
  }
}

// ── Body builders ──────────────────────────────────────────

interface BodyContent {
  lines: React.ReactNode[];
  totalLines: number;
}

interface NumberedDiffLine {
  type: "add" | "remove" | "context";
  lineNo: number;
  content: string;
  wordSegments?: WordSegment[];
}

function parseDiffWithLineNumbers(result: string): NumberedDiffLine[] {
  const allLines = result.split("\n");
  const diffLines = allLines.filter(
    (l) => !l.startsWith("---") && !l.startsWith("+++") && !l.startsWith("@@"),
  );

  const numbered: NumberedDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const line of diffLines) {
    const prefix = line[0];
    const content = line.slice(1);

    if (prefix === "+") {
      numbered.push({ type: "add", lineNo: newLine, content });
      newLine++;
    } else if (prefix === "-") {
      numbered.push({ type: "remove", lineNo: oldLine, content });
      oldLine++;
    } else {
      numbered.push({ type: "context", lineNo: newLine, content });
      oldLine++;
      newLine++;
    }
  }

  return numbered;
}

function buildDiffBody(
  result: string,
  args?: Record<string, unknown>,
  _columns?: number,
): BodyContent {
  const added = (result.match(/^\+[^+]/gm) ?? []).length;
  const removed = (result.match(/^-[^-]/gm) ?? []).length;

  const summaryText = `Added ${added} line${added !== 1 ? "s" : ""}, removed ${removed} line${removed !== 1 ? "s" : ""}`;

  const numbered = parseDiffWithLineNumbers(result);
  const firstChangeIdx = numbered.findIndex((l) => l.type !== "context");
  const lastChangeIdx =
    numbered.length - 1 - [...numbered].reverse().findIndex((l) => l.type !== "context");
  const startIdx = Math.max(0, firstChangeIdx - 2);
  const endIdx = Math.min(numbered.length, lastChangeIdx + 3);
  const focused = numbered.slice(startIdx, endIdx);

  // Compute word-level diffs for adjacent remove/add pairs.
  // Skip word-level diff when >40% of characters changed (becomes noise).
  const CHANGE_THRESHOLD = 0.4;
  for (let i = 0; i < focused.length - 1; i++) {
    if (focused[i].type === "remove" && focused[i + 1].type === "add") {
      const segments = computeWordDiff(focused[i].content, focused[i + 1].content);
      const totalLen = segments.reduce((sum, s) => sum + s.text.length, 0);
      const changedLen = segments
        .filter((s) => s.type !== "unchanged")
        .reduce((sum, s) => sum + s.text.length, 0);
      if (totalLen > 0 && changedLen / totalLen > CHANGE_THRESHOLD) continue;
      focused[i] = { ...focused[i], wordSegments: segments.filter((s) => s.type !== "added") };
      focused[i + 1] = {
        ...focused[i + 1],
        wordSegments: segments.filter((s) => s.type !== "removed"),
      };
    }
  }

  // Syntax-highlight ALL diff lines (not just context) — added/removed lines
  // get language-aware coloring overlaid with the diff background colors.
  const filePath = String(args?.file_path ?? "");
  const lang = langFromPath(filePath);
  const highlighted = focused.map((line) => ({
    ...line,
    content: highlightCode(line.content, lang),
  }));

  const maxLineNo = highlighted.reduce((m, l) => Math.max(m, l.lineNo), 0);
  const padWidth = String(maxLineNo).length;

  const displayLines = highlighted.slice(0, MAX_OUTPUT_LINES);
  const rendered = displayLines.map((line, i) => (
    <DiffLine key={i} line={line} padWidth={padWidth} />
  ));

  const diffFrame = <DiffFrame key="diff-frame">{rendered}</DiffFrame>;

  return {
    lines: [
      <Text key="summary" color="#9ca3af">
        {summaryText}
      </Text>,
      diffFrame,
    ],
    totalLines: focused.length + 1,
  };
}

function buildResultBody(
  name: string,
  result: string,
  isError: boolean,
  columns: number,
): BodyContent | null {
  if (isError) {
    const lines = result.split("\n");
    const display = lines.slice(0, MAX_OUTPUT_LINES);
    return {
      lines: display.map((l, i) => (
        <Text key={i} color="#f87171" wrap="wrap">
          {truncateLine(l, columns)}
        </Text>
      )),
      totalLines: lines.length,
    };
  }

  switch (name) {
    case "bash": {
      const allLines = result.split("\n");
      // Check exit code
      const exitMatch = allLines[0]?.match(/^Exit code: (.+)/);
      const exitCode = exitMatch ? exitMatch[1].trim() : "0";
      const outputLines = allLines.slice(1).filter((l) => l.length > 0);
      if (outputLines.length === 0) return null;
      const display = outputLines.slice(0, MAX_OUTPUT_LINES);
      return {
        lines: display.map((l, i) => (
          <Text key={i} color={exitCode !== "0" ? "#fbbf24" : "#9ca3af"} wrap="wrap">
            {truncateLine(l, columns)}
          </Text>
        )),
        totalLines: outputLines.length,
      };
    }
    case "read":
      return null;
    case "write":
      return null;
    case "grep": {
      const lines = result.split("\n").filter((l) => l.length > 0);
      if (lines.length === 0 || result === "No matches found.") return null;
      const display = lines.slice(0, MAX_OUTPUT_LINES);
      return {
        lines: display.map((l, i) => <GrepLine key={i} line={l} />),
        totalLines: lines.length,
      };
    }
    case "find": {
      const lines = result.split("\n").filter((l) => l.length > 0);
      if (lines.length === 0) return null;
      const display = lines.slice(0, MAX_OUTPUT_LINES);
      return {
        lines: display.map((l, i) => <FindLine key={i} line={l} />),
        totalLines: lines.length,
      };
    }
    case "ls": {
      const lines = result.split("\n").filter((l) => l.length > 0);
      if (lines.length === 0) return null;
      const display = lines.slice(0, MAX_OUTPUT_LINES);
      return {
        lines: display.map((l, i) => <LsLine key={i} line={l} />),
        totalLines: lines.length,
      };
    }
    case "subagent": {
      const lines = result.split("\n").filter((l) => l.length > 0);
      if (lines.length === 0) return null;
      const display = lines.slice(0, MAX_OUTPUT_LINES);
      return {
        lines: display.map((l, i) => (
          <Text key={i} color="#9ca3af" wrap="wrap">
            {truncateLine(l, columns)}
          </Text>
        )),
        totalLines: lines.length,
      };
    }
    case "skill":
      return null; // compact display with inline summary
    case "web_fetch": {
      if (result.startsWith("Error")) {
        return {
          lines: [
            <Text key={0} color="#f87171">
              {result.split("\n")[0]}
            </Text>,
          ],
          totalLines: 1,
        };
      }
      return null; // compact display with inline summary
    }
    case "source_path":
      return null; // compact display with resolved source path inline
    case "task_output": {
      const lines = result.split("\n").filter((l) => l.length > 0);
      if (lines.length === 0) return null;
      const display = lines.slice(0, MAX_OUTPUT_LINES);
      return {
        lines: display.map((line, i) => (
          <Text key={i} color={i === 0 ? "#60a5fa" : "#9ca3af"} wrap="wrap">
            {truncateLine(line, columns)}
          </Text>
        )),
        totalLines: lines.length,
      };
    }
    case "task_stop":
      return null; // compact display with inline summary
    case "tasks": {
      const lines = result.split("\n").filter((l) => l.length > 0);
      // Single-line results (add, done, remove) → compact inline display
      if (lines.length <= 1) return null;
      // Multi-line = list action → show styled task list
      const display = lines.slice(0, MAX_OUTPUT_LINES);
      return {
        lines: display.map((l, i) => <TaskLine key={i} line={l} />),
        totalLines: lines.length,
      };
    }
    default: {
      if (name.startsWith("mcp__")) {
        const lines = result.split("\n").filter((l) => l.length > 0);
        if (lines.length === 0) return null;
        const maxLines = 4;
        const display = lines.slice(0, maxLines);
        return {
          lines: display.map((l, i) => <MCPResultLine key={i} line={l} />),
          totalLines: lines.length,
        };
      }
      return null;
    }
  }
}

// ── Diff line component ────────────────────────────────────

const DiffLine = memo(function DiffLine({
  line,
  padWidth,
}: {
  line: NumberedDiffLine;
  padWidth: number;
}) {
  const lineNo = String(line.lineNo).padStart(padWidth, " ");
  const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";

  if (line.type === "add") {
    const bgColor = "#16a34a";
    const wordHighlight = "#bbf7d0";
    return (
      <Box flexDirection="row">
        <NoSelect fromLeftEdge>
          <Text backgroundColor={bgColor} color="#ffffff" dimColor>
            {lineNo} {marker}{" "}
          </Text>
        </NoSelect>
        <Text backgroundColor={bgColor} color="#ffffff">
          {line.wordSegments
            ? line.wordSegments.map((seg, i) =>
                seg.type === "added" ? (
                  <Text key={i} color={wordHighlight} bold>
                    {seg.text}
                  </Text>
                ) : (
                  <Text key={i}>{seg.text}</Text>
                ),
              )
            : line.content}
        </Text>
      </Box>
    );
  }
  if (line.type === "remove") {
    const bgColor = "#dc2626";
    const wordHighlight = "#fecaca";
    return (
      <Box flexDirection="row">
        <NoSelect fromLeftEdge>
          <Text backgroundColor={bgColor} color="#ffffff" dimColor>
            {lineNo} {marker}{" "}
          </Text>
        </NoSelect>
        <Text backgroundColor={bgColor} color="#ffffff">
          {line.wordSegments
            ? line.wordSegments.map((seg, i) =>
                seg.type === "removed" ? (
                  <Text key={i} color={wordHighlight} bold>
                    {seg.text}
                  </Text>
                ) : (
                  <Text key={i}>{seg.text}</Text>
                ),
              )
            : line.content}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="row">
      <NoSelect fromLeftEdge>
        <Text color="#6b7280">
          {lineNo} {marker}{" "}
        </Text>
      </NoSelect>
      <Text>{line.content}</Text>
    </Box>
  );
});

// ── Grep result line ───────────────────────────────────────

const GrepLine = memo(function GrepLine({ line }: { line: string }) {
  // Format: filepath:lineNo:content
  const firstColon = line.indexOf(":");
  if (firstColon === -1) return <Text color="#9ca3af">{line}</Text>;

  const secondColon = line.indexOf(":", firstColon + 1);
  if (secondColon === -1) return <Text color="#9ca3af">{line}</Text>;

  const file = line.slice(0, firstColon);
  const lineNo = line.slice(firstColon + 1, secondColon);
  const rawContent = line.slice(secondColon + 1);
  // Truncate so the full line fits within ~1 terminal row
  const cols = Math.max(40, process.stdout.columns || 80);
  const prefixLen = file.length + lineNo.length + 2; // 2 = colons
  const content = truncateLine(rawContent, cols, prefixLen + 6);

  return (
    <Text>
      <Text color="#60a5fa">{file}</Text>
      <Text color="#6b7280">:</Text>
      <Text color="#fbbf24">{lineNo}</Text>
      <Text color="#6b7280">:</Text>
      <Text color="#9ca3af">{content}</Text>
    </Text>
  );
});

// ── Find result line ───────────────────────────────────────

const FindLine = memo(function FindLine({ line }: { line: string }) {
  const trimmed = line.trim();
  if (trimmed.endsWith("/")) {
    return <Text color="#60a5fa">{trimmed}</Text>;
  }
  // Highlight the filename, dim the path
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash === -1) {
    return <Text color="#e5e7eb">{trimmed}</Text>;
  }
  return (
    <Text>
      <Text color="#6b7280">{trimmed.slice(0, lastSlash + 1)}</Text>
      <Text color="#e5e7eb">{trimmed.slice(lastSlash + 1)}</Text>
    </Text>
  );
});

// ── Ls result line ─────────────────────────────────────────

const LsLine = memo(function LsLine({ line }: { line: string }) {
  // Format: "d  -        dirname/" or "f  1.2K     filename"
  const parts = line.match(/^([dfl])\s+(\S+)\s+(.+)$/);
  if (!parts) return <Text color="#9ca3af">{line}</Text>;

  const [, type, size, name] = parts;

  if (type === "d") {
    return (
      <Text>
        <Text color="#60a5fa" bold>
          {name}
        </Text>
        <Text color="#6b7280"> {size === "-" ? "" : size}</Text>
      </Text>
    );
  }
  // File or symlink
  return (
    <Text>
      <Text color="#e5e7eb">{name}</Text>
      <Text color="#6b7280"> {size}</Text>
    </Text>
  );
});

// ── Task result line ────────────────────────────────────

const TaskLine = memo(function TaskLine({ line }: { line: string }) {
  // Format: "[✓] Task text  (id: abcd1234, done)" or "[ ] Task text  (id: ..., pending)"
  const match = line.match(/^\[(.)\]\s+(.+?)\s{2}\(id:\s*(\w+),\s*(\S+)\)$/);
  if (!match) return <Text color="#9ca3af">{line}</Text>;

  const [, check, text, id] = match;
  const isDone = check === "✓";
  const isActive = check === "~";

  return (
    <Text>
      <Text color={isDone ? "#4ade80" : isActive ? "#fbbf24" : "#6b7280"}>[{check}]</Text>
      <Text color={isDone ? "#4ade80" : isActive ? "#fbbf24" : "#e5e7eb"}> {text}</Text>
      <Text color="#6b7280"> {id}</Text>
    </Text>
  );
});

// ── MCP result line ─────────────────────────────────────

const MAX_MCP_LINE_LENGTH = 120;

function truncLine(s: string, max = MAX_MCP_LINE_LENGTH): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

const MCPResultLine = memo(function MCPResultLine({ line }: { line: string }) {
  // Key-value pattern: "Repository: value" or "Path: value" or "Title: value"
  const kvMatch = line.match(/^([A-Z][A-Za-z_ ]+):\s+(.+)$/);
  if (kvMatch) {
    return (
      <Text>
        <Text color="#6b7280">{kvMatch[1]}: </Text>
        <Text color="#60a5fa">{truncLine(kvMatch[2])}</Text>
      </Text>
    );
  }
  // URL on its own line
  if (line.match(/^https?:\/\//)) {
    return <Text color="#60a5fa">{truncLine(line)}</Text>;
  }
  // Numbered list item: "1. Title" or "- Item"
  const listMatch = line.match(/^(\d+\.\s+|- )(.+)$/);
  if (listMatch) {
    return (
      <Text>
        <Text color="#6b7280">{listMatch[1]}</Text>
        <Text color="#e5e7eb">{truncLine(listMatch[2])}</Text>
      </Text>
    );
  }
  // Dash-separated results: "repo/path — content"
  const dashMatch = line.match(/^(.+?)\s+—\s+(.+)$/);
  if (dashMatch) {
    return (
      <Text>
        <Text color="#60a5fa">{truncLine(dashMatch[1], 50)}</Text>
        <Text color="#6b7280"> — </Text>
        <Text color="#9ca3af">{truncLine(dashMatch[2], 60)}</Text>
      </Text>
    );
  }
  // Colon-separated: "file:lineNo:content"
  const colonMatch = line.match(/^([^:]+):(\d+):(.+)$/);
  if (colonMatch) {
    return (
      <Text>
        <Text color="#60a5fa">{colonMatch[1]}</Text>
        <Text color="#6b7280">:</Text>
        <Text color="#fbbf24">{colonMatch[2]}</Text>
        <Text color="#6b7280">:</Text>
        <Text color="#9ca3af">{truncLine(colonMatch[3], 80)}</Text>
      </Text>
    );
  }
  // Fallback: truncate long plain text
  return <Text color="#9ca3af">{truncLine(line)}</Text>;
});
