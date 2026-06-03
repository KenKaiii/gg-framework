import readline from "node:readline/promises";
import chalk from "chalk";
import type { MCPScope, MCPServerConfig } from "../core/mcp/index.js";
import { renderLogoBlock } from "../cli/shared.js";

const PRIMARY = "#60a5fa";
const ACCENT = "#a78bfa";
const TEXT = "#e2e8f0";
const TEXT_DIM = "#64748b";
const GOOD = "#4ade80";
const BAD = "#ef4444";

// Every MCP screen paints from the home position after a full clear, so the
// banner sits at the same row no matter which screen you came from. Mixing
// save/restore-cursor with full-clear screens is what made the banner drift.
const CLEAR_HOME = "\x1b[2J\x1b[H";

function bannerLines(version: string, subtitle: string): string[] {
  return renderLogoBlock([
    chalk.hex(PRIMARY).bold("GG Coder") +
      chalk.hex(TEXT_DIM)(` v${version}`) +
      chalk.hex(TEXT_DIM)(" · By ") +
      chalk.hex(TEXT).bold("Ken Kai"),
    chalk.hex(ACCENT)("MCP Servers"),
    chalk.hex(TEXT_DIM)(subtitle),
  ]);
}

/** A server row joined with its live connection status. */
export interface McpServerRow {
  config: MCPServerConfig;
  scope: MCPScope;
  ok: boolean;
  toolCount: number;
  error?: string;
}

export type McpDashboardAction =
  | { kind: "add" }
  | { kind: "remove"; name: string; scope: MCPScope }
  | { kind: "retry" }
  | { kind: "details"; name: string; scope: MCPScope }
  | { kind: "close" };

function transportSummary(config: MCPServerConfig): string {
  if (config.url) return config.url;
  const parts = [config.command, ...(config.args ?? [])].filter(Boolean);
  return parts.join(" ");
}

/** Render a `key label` hint with the key emphasized and the label dimmed. */
function keyHint(key: string, label: string): string {
  return chalk.hex(ACCENT).bold(key) + " " + chalk.hex(TEXT_DIM)(label);
}

function footerHints(hints: [string, string][]): string {
  return "  " + hints.map(([k, l]) => keyHint(k, l)).join(chalk.hex(TEXT_DIM)("   "));
}

/**
 * Build the navigable list: every server row, then a trailing "add" row. The
 * add row is index === rows.length so Enter on it triggers the add flow.
 */
function renderDashboard(rows: McpServerRow[], selectedIndex: number, version: string): string {
  const lines: string[] = [];
  lines.push(...bannerLines(version, "Manage your servers"));
  lines.push("");

  if (rows.length === 0) {
    lines.push(chalk.hex(TEXT_DIM)("  No MCP servers configured yet."));
    lines.push("");
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const selected = i === selectedIndex;
    const marker = selected ? chalk.hex(PRIMARY)("❯ ") : "  ";
    const dot = row.ok ? "🟢" : "🔴";
    const nameColor = selected ? PRIMARY : TEXT;
    const meta = row.ok
      ? chalk.hex(TEXT_DIM)(
          ` · ${row.toolCount} tool${row.toolCount === 1 ? "" : "s"} · ${row.scope}`,
        )
      : chalk.hex(TEXT_DIM)(` · ${row.scope} · `) + chalk.hex(BAD)(shortError(row.error));
    lines.push(`${marker}${dot} ` + chalk.hex(nameColor)(row.config.name) + meta);
  }

  // Trailing selectable "add" row.
  const addIndex = rows.length;
  const addSelected = selectedIndex === addIndex;
  const addMarker = addSelected ? chalk.hex(PRIMARY)("❯ ") : "  ";
  const addColor = addSelected ? PRIMARY : GOOD;
  lines.push(addMarker + chalk.hex(addColor)("➕ Add a new MCP server"));

  lines.push("");
  const hints: [string, string][] =
    selectedIndex === addIndex
      ? [
          ["↑↓", "navigate"],
          ["⏎", "add a server"],
          ["esc", "close"],
        ]
      : [
          ["↑↓", "navigate"],
          ["⏎", "view details"],
          ["d", "remove"],
          ["r", "retry"],
          ["esc", "close"],
        ];
  lines.push(footerHints(hints));
  return lines.join("\n");
}

/** Paint a fully-built screen string from the home position. */
function paint(content: string): void {
  process.stdout.write(CLEAR_HOME + content + "\n");
}

function shortError(error: string | undefined): string {
  if (!error) return "failed";
  const oneLine = error.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? oneLine.slice(0, 47) + "…" : oneLine;
}

/**
 * Render the interactive dashboard. Resolves with the chosen action so the
 * flow controller in cli/mcp.ts can re-run connect + redraw afterwards.
 */
export function renderMcpDashboard(options: {
  version: string;
  rows: McpServerRow[];
}): Promise<McpDashboardAction> {
  const { version, rows } = options;
  return new Promise((resolve) => {
    let selectedIndex = 0;

    const draw = () => paint(renderDashboard(rows, selectedIndex, version));

    draw();

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(CLEAR_HOME);
    };

    const finish = (action: McpDashboardAction) => {
      cleanup();
      resolve(action);
    };

    // The trailing "add" row lives at index rows.length, so the last navigable
    // index is rows.length (one past the server rows).
    const addIndex = rows.length;

    const onData = (chunk: Buffer) => {
      const key = chunk.toString();
      const onAddRow = selectedIndex === addIndex;

      if (key === "\x1b" || key === "\x03") {
        finish({ kind: "close" });
        return;
      }
      if (key === "a" || key === "A") {
        finish({ kind: "add" });
        return;
      }
      if (key === "r" || key === "R") {
        finish({ kind: "retry" });
        return;
      }
      if ((key === "d" || key === "D") && !onAddRow) {
        const row = rows[selectedIndex]!;
        finish({ kind: "remove", name: row.config.name, scope: row.scope });
        return;
      }
      if (key === "\r" || key === "\n") {
        if (onAddRow) {
          finish({ kind: "add" });
        } else {
          const row = rows[selectedIndex]!;
          finish({ kind: "details", name: row.config.name, scope: row.scope });
        }
        return;
      }
      if (key === "\x1b[A" && selectedIndex > 0) {
        selectedIndex--;
        draw();
      }
      if (key === "\x1b[B" && selectedIndex < addIndex) {
        selectedIndex++;
        draw();
      }
    };

    process.stdin.on("data", onData);
  });
}

/** Generic single-select menu mirroring renderLoginSelector. */
function renderSelector<T>(options: {
  version: string;
  subtitle: string;
  items: { label: string; value: T; description?: string }[];
}): Promise<T | null> {
  const { version, subtitle, items } = options;
  return new Promise((resolve) => {
    let selectedIndex = 0;

    const screen = (): string => {
      const lines: string[] = [];
      lines.push(...bannerLines(version, subtitle));
      lines.push("");
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const selected = i === selectedIndex;
        const marker = selected ? chalk.hex(PRIMARY)("❯ ") : "  ";
        const labelColor = selected ? PRIMARY : TEXT;
        lines.push(
          marker +
            chalk.hex(labelColor)(item.label) +
            (item.description ? chalk.hex(TEXT_DIM)(` — ${item.description}`) : ""),
        );
      }
      lines.push("");
      lines.push(
        footerHints([
          ["↑↓", "navigate"],
          ["⏎", "select"],
          ["esc", "cancel"],
        ]),
      );
      return lines.join("\n");
    };

    const draw = () => paint(screen());

    draw();
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(CLEAR_HOME);
    };

    const onData = (chunk: Buffer) => {
      const key = chunk.toString();
      if (key === "\x1b" || key === "\x03") {
        cleanup();
        resolve(null);
        return;
      }
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(items[selectedIndex]!.value);
        return;
      }
      if (key === "\x1b[A" && selectedIndex > 0) {
        selectedIndex--;
        draw();
      }
      if (key === "\x1b[B" && selectedIndex < items.length - 1) {
        selectedIndex++;
        draw();
      }
    };

    process.stdin.on("data", onData);
  });
}

export function renderScopeSelector(version: string, cwd: string): Promise<MCPScope | null> {
  return renderSelector<MCPScope>({
    version,
    subtitle: "Choose a scope",
    items: [
      { label: "Global (all GG Coder sessions)", value: "global", description: "~/.gg/mcp.json" },
      { label: `This project (${cwd})`, value: "project", description: "./.gg/mcp.json" },
    ],
  });
}

/** Read one line of input via readline (used for the paste prompt). */
export async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(chalk.hex(PRIMARY)(question));
    return answer.trim();
  } finally {
    rl.close();
  }
}

export interface BannerPromptOptions {
  /** Subtitle shown under the logo. */
  subtitle: string;
  /** The input prompt label, e.g. "Command: ". */
  question: string;
  /** Hint text shown above the prompt (default: leave empty to go back). */
  hint?: string;
}

/**
 * Paint the MCP banner from the home position (same anchor as every other
 * screen, so nothing drifts), then read one line. Returns null when the user
 * submits an empty line (treated as "go back").
 */
export async function promptWithBanner(
  version: string,
  options: BannerPromptOptions,
): Promise<string | null> {
  const { subtitle, question, hint } = options;
  const lines = [
    ...bannerLines(version, subtitle),
    "",
    chalk.hex(TEXT_DIM)("  " + (hint ?? "Leave empty and press Enter to go back.")),
    "",
  ];
  process.stdout.write(CLEAR_HOME + lines.join("\n") + "\n");

  const answer = (await promptLine("  " + question)).trim();
  return answer === "" ? null : answer;
}

export const mcpColors = {
  primary: PRIMARY,
  accent: ACCENT,
  text: TEXT,
  dim: TEXT_DIM,
  good: GOOD,
  bad: BAD,
};

export { bannerLines, transportSummary };
