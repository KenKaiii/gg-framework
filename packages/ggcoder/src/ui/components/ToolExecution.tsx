import React, { memo } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import { Spinner } from "./Spinner.js";
import { ToolUseLoader } from "./ToolUseLoader.js";
import { MessageResponse } from "./MessageResponse.js";
import { highlightCode, langFromPath } from "../utils/highlight.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { computeWordDiff, type WordSegment } from "../utils/word-diff.js";
import { DASHED_H } from "../constants/figures.js";

const MAX_OUTPUT_LINES = 4; // max lines shown per tool result

// ToolUseLoader minWidth={2} = 2 chars
const HEADER_PREFIX = 2;
// MessageResponse gutter: "  ⎿  " = 6 chars
const BODY_PREFIX = 6;

/** Truncate a line so it fits within ~1 terminal row. */
function truncateLine(line: string, cols: number, reservedChars = 6): string {
  const max = cols - reservedChars;
  return line.length > max ? line.slice(0, max) + "…" : line;
}

interface ToolRunningProps {
  status: "running";
  name: string;
  args: Record<string, unknown>;
}

interface ToolDoneProps {
  status: "done";
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  details?: unknown;
}

type ToolExecutionProps = ToolRunningProps | ToolDoneProps;

/** Tools that use compact one-line summaries instead of showing output. */
const COMPACT_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function ToolExecution(props: ToolExecutionProps) {
  const theme = useTheme();
  const { columns } = useTerminalSize();

  if (props.status === "running") {
    // Compact tools get a blinking dot + summary label
    if (COMPACT_TOOLS.has(props.name)) {
      const summary = getCompactRunningLabel(props.name, props.args);
      return (
        <Box marginTop={1} flexDirection="row">
          <ToolUseLoader status="running" />
          <Text color={theme.toolName} bold>
            {summary}
          </Text>
          <Text color={theme.textDim}>{" (ctrl+o to expand)"}</Text>
        </Box>
      );
    }
    // Non-compact tools keep the sparkle spinner with a blinking dot prefix
    const { label, detail } = getToolHeaderParts(props.name, props.args);
    return (
      <Box marginTop={1} flexDirection="row">
        <ToolUseLoader status="running" />
        <Spinner label={detail ? `${label}(${detail})` : label} />
      </Box>
    );
  }

  const { name, args, result, isError, details } = props;
  const headerContentWidth = Math.max(10, columns - HEADER_PREFIX);
  const bodyContentWidth = Math.max(10, columns - BODY_PREFIX);

  // Compact tools — one-line summary, no output content
  if (COMPACT_TOOLS.has(name) && !isError) {
    const summary = getCompactDoneLabel(name, args, result);
    return (
      <Box marginTop={1} flexDirection="row">
        <ToolUseLoader status="done" />
        <Box flexGrow={1} width={headerContentWidth}>
          <Text bold color={theme.toolName} wrap="wrap">
            {summary}
          </Text>
        </Box>
      </Box>
    );
  }

  // Extract diff from details (structured result) or fall back to result string
  const editDetails = details as { diff?: string } | undefined;
  const diffText = editDetails?.diff ?? (result.includes("---") ? result : undefined);
  const isDiff = name === "edit" && !isError && !!diffText;

  const { label, detail } = getToolHeaderParts(name, args);
  const body = isDiff
    ? buildDiffBody(diffText!, args, columns)
    : buildResultBody(name, result, isError, columns);

  const headerColor = isError ? theme.toolError : theme.toolName;

  // Compact display — no body to show, but show inline summary
  if (!body) {
    const inline = getInlineSummary(name, result, isError);
    return (
      <Box marginTop={1} flexDirection="row">
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
            {inline && <Text color={theme.textDim}> {inline}</Text>}
          </Text>
        </Box>
      </Box>
    );
  }

  const { lines, totalLines } = body;
  const hiddenCount = totalLines - lines.length;

  return (
    <Box flexDirection="column" marginTop={1}>
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
              {" lines (ctrl+o to expand)"}
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
    case "web_fetch": {
      const url = String(args.url ?? "");
      const trunc = url.length > 60 ? url.slice(0, 57) + "…" : url;
      return { label: displayName, detail: trunc };
    }
    case "tasks": {
      const action = String(args.action ?? "");
      return { label: displayName, detail: action };
    }
    default: {
      if (name.startsWith("mcp__")) {
        // Show all args as key: "value" pairs
        const argParts = Object.entries(args)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => {
            const s = String(v);
            const truncated = s.length > 40 ? s.slice(0, 37) + "…" : s;
            return `${k}: "${truncated}"`;
          });
        const detail = argParts.join(", ");
        const truncDetail = detail.length > 80 ? detail.slice(0, 77) + "…" : detail;
        return { label: displayName, detail: truncDetail };
      }
      return { label: displayName, detail: "" };
    }
  }
}

function toolDisplayName(name: string): string {
  if (name.startsWith("mcp__")) {
    // mcp__grep__searchGitHub → "grep - searchGitHub (MCP)"
    const parts = name.split("__");
    const server = parts[1] ?? "mcp";
    const toolFn = parts[2] ?? "";
    return `${server} - ${toolFn} (MCP)`;
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
    case "tasks":
      return "Task";
    default:
      return name.charAt(0).toUpperCase() + name.slice(1);
  }
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
      const firstLine = result.split("\n")[0];
      return firstLine;
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
    case "tasks": {
      // Extract just the task text from results like 'Task added: "Fix bug" (id: abc…)'
      const quoted = result.match(/"([^"]+)"/);
      if (quoted) {
        const text = quoted[1];
        return text.length > 50 ? text.slice(0, 47) + "…" : text;
      }
      return result.split("\n")[0];
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

  // Compute word-level diffs for adjacent remove/add pairs
  for (let i = 0; i < focused.length - 1; i++) {
    if (focused[i].type === "remove" && focused[i + 1].type === "add") {
      const segments = computeWordDiff(focused[i].content, focused[i + 1].content);
      focused[i] = { ...focused[i], wordSegments: segments.filter((s) => s.type !== "added") };
      focused[i + 1] = {
        ...focused[i + 1],
        wordSegments: segments.filter((s) => s.type !== "removed"),
      };
    }
  }

  // Highlight context lines using file extension
  const filePath = String(args?.file_path ?? "");
  const lang = langFromPath(filePath);
  const highlighted = focused.map((line) =>
    line.type === "context" ? { ...line, content: highlightCode(line.content, lang) } : line,
  );

  const maxLineNo = highlighted.reduce((m, l) => Math.max(m, l.lineNo), 0);
  const padWidth = String(maxLineNo).length;

  const displayLines = highlighted.slice(0, MAX_OUTPUT_LINES);
  const rendered = displayLines.map((line, i) => (
    <DiffLine key={i} line={line} padWidth={padWidth} />
  ));

  // Wrap diff lines in a dashed border frame (top/bottom only)
  const diffFrame = (
    <Box key="diff-frame" flexDirection="column">
      <Text color="#4b5563">{DASHED_H.repeat(40)}</Text>
      {rendered}
      <Text color="#4b5563">{DASHED_H.repeat(40)}</Text>
    </Box>
  );

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

  if (line.type === "add") {
    const bgColor = "#16a34a";
    const wordHighlight = "#bbf7d0"; // brighter green for changed words
    return (
      <Text backgroundColor={bgColor} color="#ffffff">
        {lineNo}
        {"  "}
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
    );
  }
  if (line.type === "remove") {
    const bgColor = "#dc2626";
    const wordHighlight = "#fecaca"; // brighter red for changed words
    return (
      <Text backgroundColor={bgColor} color="#ffffff">
        {lineNo}
        {"  "}
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
    );
  }
  return (
    <Text>
      <Text color="#6b7280">
        {lineNo}
        {"  "}
      </Text>
      {line.content}
    </Text>
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
