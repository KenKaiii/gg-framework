import React from "react";
import { Box, Text, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { UPDATE_NOTICE_TEXT, type CompletedItem } from "./app-items.js";
import { serializeCompletedItemToTerminalHistory } from "./terminal-history.js";
import { loadTheme, ThemeContext } from "./theme/theme.js";
import type { Theme } from "./theme/theme.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
import { ToolExecution } from "./components/ToolExecution.js";
import { ToolGroupExecution } from "./components/ToolGroupExecution.js";
import { ServerToolExecution } from "./components/ServerToolExecution.js";
import { MessageResponse } from "./components/MessageResponse.js";
import { ToolUseLoader } from "./components/ToolUseLoader.js";
import { SubAgentPanel } from "./components/SubAgentPanel.js";
import { CompactionDone, CompactionSpinner } from "./components/CompactionNotice.js";
import { LANGUAGE_DISPLAY_NAMES } from "../core/language-detector.js";
import { AssistantMessage } from "./components/AssistantMessage.js";
import { UserMessage } from "./components/UserMessage.js";
import { Banner } from "./components/Banner.js";
import { SessionSummaryDisplay } from "./components/SessionSummary.js";
import { BLACK_CIRCLE } from "./constants/figures.js";

const TERMINAL_COLUMNS = 68;
const theme = loadTheme("dark");
const context = {
  theme,
  columns: TERMINAL_COLUMNS,
  version: "test",
  model: "test-model",
  provider: "anthropic" as const,
  cwd: "/tmp/test",
};

function cleanLines(value: string): string[] {
  return stripAnsi(value)
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0);
}

function renderLive(element: React.ReactElement): string[] {
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  process.stdout.columns = TERMINAL_COLUMNS;
  process.stdout.rows = 20;
  try {
    return cleanLines(
      renderToString(
        <ThemeContext.Provider value={theme}>
          <TerminalSizeProvider>{element}</TerminalSizeProvider>
        </ThemeContext.Provider>,
        { columns: TERMINAL_COLUMNS },
      ),
    );
  } finally {
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
  }
}

function renderHistory(item: CompletedItem): string[] {
  return cleanLines(serializeCompletedItemToTerminalHistory(item, context));
}

function normalizeSessionSummaryLine(line: string): string | null {
  if (/^[\s╭╰─╮╯]+$/u.test(line)) return null;
  const boxed = line.match(/│(.*)│/u)?.[1] ?? line;
  const trimmed = boxed.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\s{2,}/gu, ": ").replace(/^([^:]+): (.+)$/u, "$1: $2");
}

function normalizeParityLines(kind: CompletedItem["kind"], lines: readonly string[]): string[] {
  if (kind === "user") return lines.map((line) => line.trimEnd());
  if (kind === "session_summary") {
    return lines.map(normalizeSessionSummaryLine).filter((line): line is string => line !== null);
  }
  if (kind === "style_pack" || kind === "setup_hint" || kind === "update_notice") {
    return lines.map((line) => line.replace(/─/g, "").replace(/ +(?=│$)/u, ""));
  }
  return [...lines];
}

function renderQueuedLiveItem(item: Extract<CompletedItem, { kind: "queued" }>, itemTheme: Theme) {
  const suffix = item.imageCount
    ? ` (+${item.imageCount} image${item.imageCount > 1 ? "s" : ""})`
    : "";
  return (
    <Box flexDirection="row" paddingLeft={1} marginTop={1} flexShrink={1}>
      <Box width={2} flexShrink={0}>
        <Text color={itemTheme.warning} bold>
          {"• "}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={itemTheme.text} wrap="wrap">
          <Text color={itemTheme.textDim}>Queued: </Text>
          {item.text || "(empty)"}
          {suffix}
        </Text>
      </Box>
    </Box>
  );
}

function renderGoalProgressLive(
  item: Extract<CompletedItem, { kind: "goal_progress" }>,
  itemTheme: Theme,
) {
  const isError = item.status === "failed" || item.status === "fail" || item.status === "blocked";
  const status = isError
    ? "error"
    : item.phase === "worker_finished" ||
        item.phase === "verifier_finished" ||
        item.phase === "terminal"
      ? "done"
      : "running";
  const color = isError
    ? itemTheme.error
    : item.phase === "worker_finished" || item.phase === "terminal"
      ? itemTheme.success
      : item.phase === "verifier_finished" || item.phase === "verifier_started"
        ? itemTheme.accent
        : item.phase === "orchestrator_reviewing" || item.phase === "orchestrator_working"
          ? itemTheme.secondary
          : item.phase === "continuing"
            ? itemTheme.warning
            : itemTheme.primary;
  const hasBody =
    !!item.detail ||
    (item.summaryRows !== undefined && item.summaryRows.length > 0) ||
    (item.summarySections !== undefined && item.summarySections.length > 0);

  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={1} flexShrink={1}>
      <Box flexDirection="row">
        <ToolUseLoader status={status} staticDisplay color={color} />
        <Box flexGrow={1} width={Math.max(10, TERMINAL_COLUMNS - 3)}>
          <Text wrap="wrap">
            <Text color={color} bold>
              {item.title}
            </Text>
            {item.workerId ? (
              <Text color={itemTheme.textDim}> · worker {item.workerId}</Text>
            ) : null}
          </Text>
        </Box>
      </Box>
      {hasBody ? (
        <MessageResponse>
          <Box flexDirection="column" flexShrink={1}>
            {item.detail ? (
              <Text color={itemTheme.textDim} wrap="wrap">
                {item.detail}
              </Text>
            ) : null}
            {item.summaryRows?.map((row) => (
              <Text key={row.label} wrap="truncate">
                <Text color={itemTheme.textDim}>{row.label.padEnd(12)}</Text>
                <Text color={itemTheme.text}>{row.value}</Text>
                {row.detail ? <Text color={itemTheme.textDim}> · {row.detail}</Text> : null}
              </Text>
            ))}
            {item.summarySections?.map((section) => (
              <Box key={section.title} flexDirection="column" marginTop={1} flexShrink={1}>
                <Text color={itemTheme.textDim} bold>
                  {section.title}
                </Text>
                {section.lines.map((line, index) => (
                  <Text key={`${section.title}-${index}`} color={itemTheme.text} wrap="wrap">
                    {`• ${line}`}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        </MessageResponse>
      ) : null}
    </Box>
  );
}

function renderStatusLive(
  glyph: string,
  content: React.ReactNode,
  glyphColor: string,
  itemTheme: Theme,
  options: { bold?: boolean; muted?: boolean } = {},
) {
  return (
    <Box flexDirection="row" paddingLeft={1} marginTop={1} flexShrink={1}>
      <Box width={2} flexShrink={0}>
        <Text color={glyphColor} bold={options.bold ?? true}>
          {glyph}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text
          color={options.muted ? itemTheme.textDim : itemTheme.commandColor}
          bold={options.bold}
          wrap="wrap"
        >
          {content}
        </Text>
      </Box>
    </Box>
  );
}

function renderStylePackLive(
  item: Extract<CompletedItem, { kind: "style_pack" }>,
  itemTheme: Theme,
) {
  const names = item.added.map((id) => LANGUAGE_DISPLAY_NAMES[id]);
  const headerLabel = item.added.length > 1 ? "STYLE PACKS ACTIVE" : "STYLE PACK ACTIVE";
  return (
    <Box paddingLeft={1} marginTop={1} flexShrink={1}>
      <Box
        flexShrink={1}
        flexDirection="column"
        borderStyle="round"
        borderColor={itemTheme.language}
        paddingX={1}
      >
        <Text wrap="wrap">
          <Text color={itemTheme.language} bold>
            {"◆ "}
          </Text>
          <Text color={itemTheme.language} bold>
            {headerLabel}
          </Text>
        </Text>
        <Text color={itemTheme.text} bold wrap="wrap">
          {names.join(", ")}
        </Text>
        {item.showSetupHint && (
          <Box marginTop={1}>
            <Text wrap="wrap">
              <Text color={itemTheme.textMuted}>{"Tip: run "}</Text>
              <Text color={itemTheme.language} bold>
                {"/setup"}
              </Text>
              <Text color={itemTheme.textMuted}>
                {" to audit this project against the active pack(s)"}
              </Text>
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function renderSetupHintLive(itemTheme: Theme) {
  return (
    <Box paddingLeft={1} marginTop={1} flexShrink={1}>
      <Box
        flexShrink={1}
        flexDirection="column"
        borderStyle="round"
        borderColor={itemTheme.language}
        paddingX={1}
      >
        <Text wrap="wrap">
          <Text color={itemTheme.language} bold>
            {"◆ "}
          </Text>
          <Text color={itemTheme.language} bold>
            {"NO STYLE PACKS DETECTED"}
          </Text>
        </Text>
        <Text color={itemTheme.textMuted} wrap="wrap">
          {"This directory has no recognized language manifest at its root."}
        </Text>
        <Box marginTop={1}>
          <Text wrap="wrap">
            <Text color={itemTheme.textMuted}>{"Tip: run "}</Text>
            <Text color={itemTheme.language} bold>
              {"/setup"}
            </Text>
            <Text color={itemTheme.textMuted}>
              {" to audit project hygiene or bootstrap a new project from scratch"}
            </Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

function renderUpdateNoticeLive(
  _item: Extract<CompletedItem, { kind: "update_notice" }>,
  itemTheme: Theme,
) {
  return (
    <Box paddingLeft={1} marginTop={1} flexShrink={1}>
      <Box flexShrink={1} borderStyle="round" borderColor={itemTheme.commandColor} paddingX={1}>
        <Text color={itemTheme.commandColor} bold wrap="wrap">
          {UPDATE_NOTICE_TEXT}
        </Text>
      </Box>
    </Box>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled completed item in TUI parity test: ${JSON.stringify(value)}`);
}

function liveElementFor(item: CompletedItem): React.ReactElement | null {
  switch (item.kind) {
    case "banner":
      return (
        <Banner
          version={context.version}
          model={context.model}
          provider={context.provider}
          cwd={context.cwd}
        />
      );
    case "user":
      return (
        <UserMessage text={item.text} imageCount={item.imageCount} pasteInfo={item.pasteInfo} />
      );
    case "assistant":
      return (
        <AssistantMessage text={item.text} thinking={item.thinking} thinkingMs={item.thinkingMs} />
      );
    case "goal":
      return (
        <Box paddingLeft={1} marginTop={1}>
          <Text wrap="wrap">
            <Text color={theme.success} bold>
              {"▶ "}
            </Text>
            <Text color={theme.textDim}>{"Goal: "}</Text>
            <Text color={theme.success}>{item.title}</Text>
            {item.workerId ? <Text color={theme.textDim}> · worker {item.workerId}</Text> : null}
          </Text>
        </Box>
      );
    case "task":
      return renderStatusLive(
        "▸ ",
        <>
          <Text color={theme.textDim}>{"Task: "}</Text>
          <Text color={theme.commandColor} bold>
            {item.title}
          </Text>
        </>,
        theme.commandColor,
        theme,
        { bold: true },
      );
    case "queued":
      return renderQueuedLiveItem(item, theme);
    case "tool_start":
      return (
        <ToolExecution
          status="running"
          name={item.name}
          args={item.args}
          progressOutput={item.progressOutput}
          animateUntil={0}
        />
      );
    case "tool_done":
      return (
        <ToolExecution
          status="done"
          name={item.name}
          args={item.args}
          result={item.result}
          isError={item.isError}
          details={item.details}
        />
      );
    case "tool_group":
      return <ToolGroupExecution tools={item.tools} />;
    case "server_tool_start":
      return (
        <ServerToolExecution
          status="running"
          name={item.name}
          input={item.input}
          startedAt={0}
          animateUntil={0}
        />
      );
    case "server_tool_done":
      return (
        <ServerToolExecution
          status="done"
          name={item.name}
          input={item.input}
          durationMs={item.durationMs}
          resultType={item.resultType}
        />
      );
    case "subagent_group":
      return <SubAgentPanel agents={item.agents} aborted={item.aborted} />;
    case "goal_progress":
      return renderGoalProgressLive(item, theme);
    case "style_pack":
      return renderStylePackLive(item, theme);
    case "setup_hint":
      return renderSetupHintLive(theme);
    case "update_notice":
      return renderUpdateNoticeLive(item, theme);
    case "compacting":
      return <CompactionSpinner staticDisplay />;
    case "compacted":
      return (
        <CompactionDone
          originalCount={item.originalCount}
          newCount={item.newCount}
          tokensBefore={item.tokensBefore}
          tokensAfter={item.tokensAfter}
        />
      );
    case "error": {
      const showMessage = item.message && item.message !== item.headline;
      return (
        <Box flexDirection="row" paddingLeft={1} marginTop={1} flexShrink={1}>
          <Box width={2} flexShrink={0}>
            <Text color={theme.error} bold>
              {"✗ "}
            </Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Text color={theme.error} wrap="wrap">
              {item.headline}
            </Text>
            {showMessage && (
              <Text color={theme.textDim} wrap="wrap">
                {item.message}
              </Text>
            )}
            <Text color={theme.textDim} wrap="wrap">{`→ ${item.guidance}`}</Text>
          </Box>
        </Box>
      );
    }
    case "info":
      return renderStatusLive("○ ", item.text, theme.commandColor, theme, { muted: true });
    case "plan_transition":
      return renderStatusLive(
        `${BLACK_CIRCLE} `,
        item.text.replace(/\\n/g, "\n").replace(/^\n+|\n+$/g, ""),
        theme.commandColor,
        theme,
        { bold: true },
      );
    case "goal_agent_transition":
      return renderStatusLive(
        `${BLACK_CIRCLE} `,
        item.text.replace(/\\n/g, "\n").replace(/^\n+|\n+$/g, ""),
        theme.commandColor,
        theme,
        { bold: true },
      );
    case "model_transition":
      return renderStatusLive(
        "▸ ",
        <>
          <Text color={theme.textDim}>{"Switched to "}</Text>
          <Text color={theme.commandColor} bold>
            {item.modelName}
          </Text>
        </>,
        theme.commandColor,
        theme,
        { bold: true },
      );
    case "theme_transition":
      return renderStatusLive(
        "◐ ",
        <>
          <Text color={theme.textDim}>{"Theme switched to "}</Text>
          <Text color={theme.commandColor} bold>
            {item.themeName}
          </Text>
        </>,
        theme.commandColor,
        theme,
        { bold: true },
      );
    case "plan_event": {
      const label =
        item.event === "approved"
          ? "Plan approved"
          : item.event === "rejected"
            ? "Plan rejected"
            : "Plan dismissed";
      return renderStatusLive(
        "○ ",
        <>
          <Text>{label}</Text>
          {item.detail ? <Text color={theme.textDim}>{` — "${item.detail}"`}</Text> : null}
        </>,
        theme.commandColor,
        theme,
        { bold: true },
      );
    }
    case "stopped":
      return renderStatusLive(
        "⊘ ",
        item.text.replace(/\\n/g, "\n").replace(/^\n+|\n+$/g, ""),
        theme.commandColor,
        theme,
        { bold: true },
      );
    case "step_done":
      return (
        <Box paddingLeft={1} marginTop={1} flexShrink={1}>
          <Text wrap="wrap">
            <Text color={theme.success} bold>
              {"✓ "}
            </Text>
            <Text color={theme.success} bold>
              {`Step ${item.stepNum} done`}
            </Text>
            {item.description ? (
              <Text color={theme.textDim}>{` — ${item.description}`}</Text>
            ) : null}
          </Text>
        </Box>
      );
    case "duration":
      return (
        <Box paddingLeft={1} marginTop={1}>
          <Text color={theme.textDim}>{`✻ ${item.verb} 2m 3s`}</Text>
        </Box>
      );
    case "session_summary":
      return <SessionSummaryDisplay summary={item.summary} />;
    case "tombstone":
      return null;
    default:
      return assertNever(item);
  }
}

type RenderedParityKind = Exclude<CompletedItem["kind"], "tombstone">;
type ParityCaseByKind = {
  [Kind in RenderedParityKind]: Extract<CompletedItem, { kind: Kind }>;
};

const parityCaseByKind = {
  banner: { kind: "banner", id: "banner" },
  user: { kind: "user", id: "user-1", text: "hello from user", imageCount: 1 },
  assistant: { kind: "assistant", id: "assistant-1", text: "Hello **world** from assistant" },
  goal: { kind: "goal", id: "goal-1", title: "Ship the TUI polish", workerId: "worker-1" },
  task: { kind: "task", id: "task-1", title: "Restore task pane" },
  queued: { kind: "queued", id: "queued-1", text: "next prompt with wrapping words" },
  tool_start: {
    kind: "tool_start",
    id: "read-start",
    toolCallId: "read-start",
    name: "read",
    args: { file_path: "src/a.ts" },
    startedAt: 0,
    animateUntil: 0,
  },
  tool_done: {
    kind: "tool_done",
    id: "read-done",
    name: "read",
    args: { file_path: "src/a.ts" },
    result: "1\tconst a = 1;",
    isError: false,
    durationMs: 1000,
  },
  tool_group: {
    kind: "tool_group",
    id: "tool-group",
    tools: [
      {
        toolCallId: "read-1",
        name: "read",
        args: { file_path: "src/a.ts" },
        status: "done",
        result: "ok",
      },
    ],
  },
  server_tool_start: {
    kind: "server_tool_start",
    id: "server-start",
    serverToolCallId: "server-start",
    name: "web_search",
    input: { query: "latest docs" },
    startedAt: 0,
    animateUntil: 0,
  },
  server_tool_done: {
    kind: "server_tool_done",
    id: "server-done",
    name: "web_search",
    input: { query: "latest docs" },
    resultType: "search_result",
    data: {},
    durationMs: 2400,
  },
  subagent_group: {
    kind: "subagent_group",
    id: "subagent",
    agents: [
      {
        toolCallId: "agent-1",
        agentName: "bee",
        task: "Inspect widgets",
        status: "done",
        toolUseCount: 2,
        tokenUsage: { input: 1200, output: 300 },
        durationMs: 1800,
      },
    ],
  },
  goal_progress: {
    kind: "goal_progress",
    id: "goal-progress",
    phase: "worker_finished",
    title: "Worker finished",
    detail: "Completed the audit.",
    workerId: "worker-1",
    status: "done",
    summaryRows: [{ label: "tests", value: "passed", detail: "3 files" }],
    summarySections: [{ title: "Evidence", lines: ["unit test passed"] }],
  },
  style_pack: {
    kind: "style_pack",
    id: "style-pack",
    added: ["typescript"],
    showSetupHint: true,
  },
  setup_hint: { kind: "setup_hint", id: "setup-hint" },
  update_notice: {
    kind: "update_notice",
    id: "update-notice",
    text: "Ken just pushed a fresh update — 4.3.214 → 4.3.215! I'll grab it on next launch (or run npm install -g @kenkaiiii/ggcoder@latest if you can't wait).",
  },
  compacting: { kind: "compacting", id: "compacting" },
  compacted: {
    kind: "compacted",
    id: "compacted",
    originalCount: 279,
    newCount: 39,
    tokensBefore: 184000,
    tokensAfter: 26000,
  },
  error: {
    kind: "error",
    id: "error",
    headline: "Provider returned an error.",
    message: "Rate limit exceeded.",
    guidance: "Retry after a moment.",
  },
  info: { kind: "info", id: "info", text: "Configuration saved" },
  plan_transition: { kind: "plan_transition", id: "plan", text: "Plan mode ON", active: true },
  goal_agent_transition: { kind: "goal_agent_transition", id: "goal-agent", text: "Goal agent ON" },
  model_transition: { kind: "model_transition", id: "model", modelName: "Claude Sonnet" },
  theme_transition: { kind: "theme_transition", id: "theme", themeName: "dark" },
  plan_event: { kind: "plan_event", id: "plan-event", event: "approved", detail: "ship it" },
  stopped: { kind: "stopped", id: "stopped", text: "Stopped" },
  step_done: { kind: "step_done", id: "step-done", stepNum: 2, description: "Wire final renderer" },
  duration: {
    kind: "duration",
    id: "duration",
    durationMs: 123000,
    toolsUsed: ["bash"],
    verb: "Executed commands for",
  },
  session_summary: {
    kind: "session_summary",
    id: "session-summary",
    summary: {
      title: "GG Coder is powering down. Goodbye!",
      sessionId: "session.jsonl",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      cwd: "/tmp/project",
      wallDurationMs: 123000,
      turns: 2,
      usage: { inputTokens: 1000, outputTokens: 250, cacheRead: 50 },
      tools: {
        totalCalls: 2,
        totalSuccess: 1,
        totalFail: 1,
        totalDurationMs: 3000,
        byName: { bash: { calls: 2, success: 1, fail: 1, durationMs: 3000 } },
      },
      serverToolCalls: 0,
      linesChanged: { added: 3, removed: 1 },
      footer: "To resume this session: ggcoder --resume session.jsonl",
    },
  },
} satisfies ParityCaseByKind;

const supplementalParityCases: CompletedItem[] = [
  {
    kind: "tool_start",
    id: "bash-start",
    toolCallId: "bash-start",
    name: "bash",
    args: { command: "printf hi" },
    progressOutput: "first line\nsecond line",
    startedAt: 0,
    animateUntil: 0,
  },
  {
    kind: "tool_done",
    id: "bash-done",
    name: "bash",
    args: { command: "printf hi" },
    result: "Exit code: 0\nhi",
    isError: false,
    durationMs: 1000,
  },
  {
    kind: "tool_start",
    id: "mcp-search-code-start",
    toolCallId: "mcp-search-code-start",
    name: "mcp__kencode-search__searchCode",
    args: { query: "useState(", language: ["TypeScript"] },
    startedAt: 0,
    animateUntil: 0,
  },
  {
    kind: "tool_done",
    id: "mcp-search-code-done",
    name: "mcp__kencode-search__searchCode",
    args: { query: "useState(", language: ["TypeScript"] },
    result:
      'Repo: owner/project (★123, MIT)\nFile: src/App.tsx\nLink: https://github.com/owner/project/blob/main/src/App.tsx\n\n12 │ const [value, setValue] = useState("");',
    isError: false,
    durationMs: 1000,
  },
];

const parityCases = [...Object.values(parityCaseByKind), ...supplementalParityCases];

describe("TUI live/history parity", () => {
  it.each(parityCases.map((item) => [item.kind, item] as const))(
    "keeps %s live rendering aligned with terminal history",
    (_kind, item) => {
      const liveElement = liveElementFor(item);
      expect(liveElement).not.toBeNull();
      const liveLines = renderLive(liveElement!);
      const historyLines = renderHistory(item);

      expect(normalizeParityLines(item.kind, liveLines), item.kind).toEqual(
        normalizeParityLines(item.kind, historyLines),
      );
      for (const line of liveLines) {
        expect(stringWidth(line), `${item.kind}: ${line}`).toBeLessThanOrEqual(TERMINAL_COLUMNS);
      }
    },
  );
});
