import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INGEST_URL } from "@kenkaiiii/gg-pixel";
import { fetchPixelEntries, type PixelEntry, type PixelFetchResult } from "../core/pixel.js";
import { renderLogoBlock } from "../cli/shared.js";

const PRIMARY = "#a78bfa";
const TEXT = "#e2e8f0";
const TEXT_DIM = "#94a3b8";
const RULE = "#ffffff";

let _version = "";

export type PixelSelection =
  | {
      kind: "one";
      errorId: string;
      projectId: string;
      projectName: string;
      projectPath: string;
    }
  | { kind: "all" };

interface RenderOptions {
  /** Override the home directory used to look up `~/.gg/projects.json`. */
  homeDir?: string;
  ingestUrl?: string;
  fetchFn?: typeof fetch;
  version?: string;
}

export async function renderPixelSelector(
  opts: RenderOptions = {},
): Promise<PixelSelection | null> {
  _version = opts.version ?? "";
  const data = await fetchPixelEntries({
    homeDir: opts.homeDir,
    ingestUrl: opts.ingestUrl,
    fetchFn: opts.fetchFn,
  });

  return new Promise((resolve) => {
    let selectedIndex = 0;

    const draw = () => {
      // Clear scrollback + home cursor + clear below — keeps the rendered frame
      // anchored at the top of the terminal so the selection never scrolls
      // off-screen.
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H" + renderScreen(data, selectedIndex) + "\n");
    };

    draw();

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    };

    const onData = (chunk: Buffer) => {
      const key = chunk.toString();

      if (key === "\x03") {
        cleanup();
        resolve(null);
        return;
      }
      if (key === "\x1b[A" || key === "\x1bOA") {
        if (selectedIndex > 0) {
          selectedIndex--;
          draw();
        }
        return;
      }
      if (key === "\x1b[B" || key === "\x1bOB") {
        if (selectedIndex < data.entries.length - 1) {
          selectedIndex++;
          draw();
        }
        return;
      }
      if (key === "\x1b") {
        cleanup();
        resolve(null);
        return;
      }
      if (key === "\r" || key === "\n") {
        if (data.entries.length === 0) return;
        const entry = data.entries[selectedIndex];
        if (!entry) return;
        cleanup();
        resolve({
          kind: "one",
          errorId: entry.errorId,
          projectId: entry.projectId,
          projectName: entry.projectName,
          projectPath: entry.projectPath,
        });
        return;
      }
      if (key === "f" || key === "r") {
        if (data.entries.length === 0) return;
        cleanup();
        resolve({ kind: "all" });
        return;
      }
      if (key === "d" || key === "\x7f") {
        if (data.entries.length === 0) return;
        const entry = data.entries[selectedIndex];
        if (!entry) return;
        // Optimistic local removal; fire-and-forget to backend.
        data.entries.splice(selectedIndex, 1);
        if (selectedIndex >= data.entries.length) {
          selectedIndex = Math.max(0, data.entries.length - 1);
        }
        const ingest = (opts.ingestUrl ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
        const fetchFn = opts.fetchFn ?? fetch;
        const secret = readProjectSecret(opts.homeDir, entry.projectId);
        if (secret) {
          void fetchFn(`${ingest}/api/errors/${entry.errorId}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${secret}` },
          }).catch(() => {
            // Backend may be unreachable; the row will reappear on next fetch.
          });
        }
        draw();
        return;
      }
      if (key === "q") {
        cleanup();
        resolve(null);
        return;
      }
    };

    process.stdin.on("data", onData);
  });
}

export function renderScreen(
  data: PixelFetchResult,
  selectedIndex: number,
  opts: { version?: string } = {},
): string {
  const lines: string[] = [];
  const version = opts.version ?? _version;

  for (const row of renderLogoBlock([
    chalk.hex("#60a5fa").bold("GG Coder") +
      (version ? chalk.hex(TEXT_DIM)(` v${version}`) : "") +
      chalk.hex(TEXT_DIM)(" · By ") +
      chalk.hex(TEXT).bold("Ken Kai"),
    chalk.hex(PRIMARY)("Pixel"),
    chalk.hex(TEXT_DIM)(summarize(data)),
  ])) {
    lines.push(row);
  }
  lines.push("");
  lines.push("");

  if (!data.hasProjects) {
    lines.push(chalk.hex(TEXT_DIM)("  No projects registered yet."));
    lines.push("");
    lines.push(
      "  Run " +
        chalk.hex(PRIMARY).bold("ggcoder pixel install") +
        chalk.hex(TEXT_DIM)(" inside any project to wire it up."),
    );
  } else if (data.entries.length === 0) {
    lines.push(chalk.hex("#4ade80")("  ✓ No open errors. Queue is clean."));
  } else {
    const { visible, startIdx, hiddenAbove, hiddenBelow } = windowEntries(
      data.entries,
      selectedIndex,
      availableRows(),
    );
    if (hiddenAbove > 0) lines.push(chalk.hex(TEXT_DIM)(`  ↑ ${hiddenAbove} more`));
    renderTables(visible, selectedIndex - startIdx, lines);
    if (hiddenBelow > 0) lines.push(chalk.hex(TEXT_DIM)(`  ↓ ${hiddenBelow} more`));
  }

  if (data.unreachable.length > 0) {
    lines.push("");
    for (const name of data.unreachable) {
      lines.push(chalk.hex("#ef4444")(`  ✗ ${name}: backend unreachable`));
    }
  }

  if (data.unmanaged.length > 0) {
    lines.push("");
    for (const name of data.unmanaged) {
      lines.push(
        chalk.hex("#fbbf24")(
          `  ⚠ ${name}: missing bearer secret — re-run \`ggcoder pixel install\``,
        ),
      );
    }
  }

  lines.push("");
  if (data.entries.length > 0) {
    lines.push(
      chalk.hex(TEXT_DIM)("  ↑↓ navigate · ") +
        chalk.hex(PRIMARY)("Enter") +
        chalk.hex(TEXT_DIM)(" fix one · ") +
        chalk.hex(PRIMARY)("f") +
        chalk.hex(TEXT_DIM)(" fix all · ") +
        chalk.hex(PRIMARY)("d") +
        chalk.hex(TEXT_DIM)(" delete · ") +
        chalk.hex(PRIMARY)("Esc") +
        chalk.hex(TEXT_DIM)(" close"),
    );
  } else {
    lines.push(chalk.hex(TEXT_DIM)("  Esc close"));
  }
  return lines.join("\n");
}

// Box-drawing matches the TUI markdown table renderer (`token-to-ansi.ts`).
const BOX = {
  tl: "┏",
  tr: "┓",
  bl: "┗",
  br: "┛",
  v: "┃",
  h: "━",
  cross: "╋",
  tDown: "┳",
  tUp: "┻",
  tRight: "┣",
  tLeft: "┫",
};

const COL_TYPE = 16;
const COL_LOC = 30;
const COL_COUNT = 5;
const COL_AGE = 4;
const COL_STATUS = 8;
const COL_WIDTHS = [COL_TYPE, COL_LOC, COL_COUNT, COL_AGE, COL_STATUS];

function renderTables(entries: PixelEntry[], selectedIndex: number, lines: string[]): void {
  const groups = new Map<string, { entries: Array<{ entry: PixelEntry; absIdx: number }> }>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (!groups.has(e.projectName)) groups.set(e.projectName, { entries: [] });
    groups.get(e.projectName)!.entries.push({ entry: e, absIdx: i });
  }

  const projectNames = [...groups.keys()];
  for (let g = 0; g < projectNames.length; g++) {
    if (g > 0) lines.push("");
    const name = projectNames[g]!;
    const rows = groups.get(name)!.entries;

    lines.push(
      "  " +
        chalk.hex(PRIMARY).bold(name) +
        chalk.hex(TEXT_DIM)(`  ·  ${rows.length} ${rows.length === 1 ? "error" : "errors"}`),
    );
    lines.push("  " + hLine(BOX.tl, BOX.tDown, BOX.tr));
    lines.push("  " + headerRow());
    lines.push("  " + hLine(BOX.tRight, BOX.cross, BOX.tLeft));
    for (let r = 0; r < rows.length; r++) {
      const { entry, absIdx } = rows[r]!;
      lines.push("  " + dataRow(entry, absIdx === selectedIndex));
      if (r < rows.length - 1) lines.push("  " + hLine(BOX.tRight, BOX.cross, BOX.tLeft));
    }
    lines.push("  " + hLine(BOX.bl, BOX.tUp, BOX.br));
  }
}

function hLine(left: string, mid: string, right: string): string {
  const segs = COL_WIDTHS.map((w) => BOX.h.repeat(w + 2)).join(mid);
  return chalk.hex(RULE)(left + segs + right);
}

function headerRow(): string {
  const cells = [
    pad("TYPE", COL_TYPE, "left"),
    pad("LOCATION", COL_LOC, "left"),
    pad("×", COL_COUNT, "right"),
    pad("AGE", COL_AGE, "right"),
    pad("STATUS", COL_STATUS, "center"),
  ].map((c) => chalk.hex(TEXT_DIM).bold(c));
  return joinCells(cells);
}

function dataRow(entry: PixelEntry, selected: boolean): string {
  const typeText = truncate(entry.type, COL_TYPE - 2);
  const chevron = selected ? "❯ " : "  ";
  const typeColor = selected ? PRIMARY : TEXT;
  const typeContent = chevron + typeText;
  const typeCell = chalk.hex(typeColor).bold(pad(typeContent, COL_TYPE, "left"));

  const locText = truncateLeft(entry.location, COL_LOC);
  const locCell = chalk.hex(TEXT_DIM)(pad(locText, COL_LOC, "left"));

  const countCell =
    entry.recurrenceCount > 0
      ? chalk.hex("#fbbf24")(pad(`↻${entry.recurrenceCount}`, COL_COUNT, "right"))
      : chalk.hex(TEXT_DIM)(pad(`×${entry.occurrences}`, COL_COUNT, "right"));

  const ageCell = chalk.hex(TEXT_DIM)(pad(formatAge(entry.lastSeenAt), COL_AGE, "right"));

  const statusCell = statusBadgeCell(entry.status);

  return joinCells([typeCell, locCell, countCell, ageCell, statusCell]);
}

function joinCells(cells: string[]): string {
  const v = chalk.hex(RULE)(BOX.v);
  return v + " " + cells.join(" " + v + " ") + " " + v;
}

function pad(s: string, width: number, align: "left" | "right" | "center"): string {
  const visible = stringVisibleLen(s);
  if (visible >= width) return s;
  const diff = width - visible;
  if (align === "left") return s + " ".repeat(diff);
  if (align === "right") return " ".repeat(diff) + s;
  const left = Math.floor(diff / 2);
  return " ".repeat(left) + s + " ".repeat(diff - left);
}

function stringVisibleLen(s: string): number {
  // Plain string in our rows — chevron + ASCII or single-width Unicode.
  // Treat each char as 1 col; matches what's coming out of pad().
  return [...s].length;
}

function statusBadgeCell(status: string): string {
  // Pad to COL_STATUS visual cells, then apply background color.
  const label =
    status === "open"
      ? "OPEN"
      : status === "in_progress"
        ? "WORKING"
        : status === "awaiting_review"
          ? "REVIEW"
          : status === "failed"
            ? "FAILED"
            : status.toUpperCase();
  const padded = pad(label, COL_STATUS, "center");
  if (status === "open") return chalk.bgHex("#dc2626").white.bold(padded);
  if (status === "in_progress") return chalk.bgHex("#2563eb").white.bold(padded);
  if (status === "awaiting_review") return chalk.bgHex("#eab308").black.bold(padded);
  if (status === "failed") return chalk.bgHex("#7f1d1d").white.bold(padded);
  return chalk.bgHex("#374151").white.bold(padded);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function truncateLeft(s: string, n: number): string {
  if (s.length <= n) return s;
  return "…" + s.slice(s.length - n + 1);
}

function formatAge(ms?: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) return "now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}

function summarize(data: PixelFetchResult): string {
  if (!data.hasProjects) return "Nothing registered yet";
  if (data.entries.length === 0) return "All clean";
  const counts: Record<string, number> = {};
  for (const e of data.entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  const parts: string[] = [];
  if (counts.open) parts.push(`${counts.open} open`);
  if (counts.in_progress) parts.push(`${counts.in_progress} working`);
  if (counts.awaiting_review) parts.push(`${counts.awaiting_review} awaiting review`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return parts.join(" · ");
}

// ── Viewport ─────────────────────────────────────────────────────────────

interface Window {
  visible: PixelEntry[];
  startIdx: number;
  hiddenAbove: number;
  hiddenBelow: number;
}

function availableRows(): number {
  // Banner(3) + blank + footer + blanks/scroll-hint margin ≈ 8.
  // Each entry consumes ~2 rows (data row + separator).
  // Each project header consumes ~5 rows (header label, top border, header
  // row, header separator, bottom border).
  // Be conservative: assume a single project group → only entry rows count.
  const term = process.stdout.rows ?? 30;
  const overhead = 8;
  const perEntry = 2;
  const perProjectGroup = 5;
  // Reserve room for at least one project group's chrome.
  const usable = Math.max(0, term - overhead - perProjectGroup);
  return Math.max(1, Math.floor(usable / perEntry));
}

function windowEntries(entries: PixelEntry[], selectedIndex: number, maxVisible: number): Window {
  const total = entries.length;
  if (total <= maxVisible) {
    return { visible: entries, startIdx: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }
  let startIdx = selectedIndex - Math.floor(maxVisible / 2);
  if (startIdx < 0) startIdx = 0;
  if (startIdx + maxVisible > total) startIdx = total - maxVisible;
  return {
    visible: entries.slice(startIdx, startIdx + maxVisible),
    startIdx,
    hiddenAbove: startIdx,
    hiddenBelow: total - (startIdx + maxVisible),
  };
}

function readProjectSecret(homeDir: string | undefined, projectId: string): string | null {
  const path = join(homeDir ?? homedir(), ".gg", "projects.json");
  if (!existsSync(path)) return null;
  try {
    const map = JSON.parse(readFileSync(path, "utf8")) as Record<string, { secret?: string }>;
    return map[projectId]?.secret ?? null;
  } catch {
    return null;
  }
}
