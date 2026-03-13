import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { SessionManager, type SessionInfo } from "../core/session-manager.js";

const LOGO_LINES = [" ▄▀▀▀ ▄▀▀▀", " █ ▀█ █ ▀█", " ▀▄▄▀ ▀▄▄▀"];
const GRADIENT = ["#a78bfa", "#9b8af6", "#8f89f1", "#8388ec", "#7787e7", "#6b86e2", "#60a5fa"];
const GAP = "   ";

const PRIMARY = "#a78bfa";
const TEXT = "#e2e8f0";
const TEXT_DIM = "#64748b";

const MAX_PROMPT_LEN = 40;

interface SessionDisplay {
  info: SessionInfo;
  firstPrompt: string;
}

function gradientLine(text: string): string {
  let result = "";
  let colorIdx = 0;
  for (const ch of text) {
    if (ch === " ") {
      result += ch;
    } else {
      const color = GRADIENT[Math.min(colorIdx, GRADIENT.length - 1)];
      result += chalk.hex(color!)(ch);
      colorIdx++;
    }
  }
  return result;
}

function formatRelativeTime(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(isoTimestamp).toLocaleDateString();
}

/** Extract first user prompt from a session JSONL file */
async function extractFirstPrompt(sessionPath: string): Promise<string> {
  try {
    const content = await readFile(sessionPath, "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as {
          type: string;
          message?: { role: string; content: string | { type: string; text?: string }[] };
        };
        if (entry.type === "message" && entry.message?.role === "user") {
          const c = entry.message.content;
          let text: string;
          if (typeof c === "string") {
            text = c;
          } else if (Array.isArray(c)) {
            text =
              c
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text!)
                .join(" ") || "";
          } else {
            continue;
          }
          // Collapse whitespace and truncate
          text = text.replace(/\s+/g, " ").trim();
          if (text.length > MAX_PROMPT_LEN) {
            text = text.slice(0, MAX_PROMPT_LEN) + "...";
          }
          return text || "(empty)";
        }
      } catch {
        // Skip unparseable lines
      }
    }
  } catch {
    // File read error
  }
  return "(no prompt)";
}

function renderScreen(sessions: SessionDisplay[], selectedIndex: number): string {
  const lines: string[] = [];

  lines.push(gradientLine(LOGO_LINES[0]!) + GAP + chalk.hex(PRIMARY).bold("Sessions"));
  lines.push(
    gradientLine(LOGO_LINES[1]!) + GAP + chalk.hex(TEXT_DIM)("Select a session to resume"),
  );
  lines.push(gradientLine(LOGO_LINES[2]!));
  lines.push("");

  if (sessions.length === 0) {
    lines.push(chalk.hex(TEXT_DIM)("  No sessions found for this directory."));
  } else {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      const selected = i === selectedIndex;
      const marker = selected ? "❯ " : "  ";
      const labelColor = selected ? PRIMARY : TEXT;
      const time = formatRelativeTime(s.info.timestamp);
      const msgs = `${s.info.messageCount} msg${s.info.messageCount !== 1 ? "s" : ""}`;
      lines.push(
        chalk.hex(labelColor)(marker + s.firstPrompt) + chalk.hex(TEXT_DIM)(` — ${msgs} · ${time}`),
      );
    }
  }

  lines.push("");
  lines.push(chalk.hex(TEXT_DIM)("↑↓ navigate · Enter select · Esc cancel"));

  return lines.join("\n");
}

export async function renderSessionSelector(
  sessionsDir: string,
  cwd: string,
): Promise<string | null> {
  const manager = new SessionManager(sessionsDir);
  const allSessions = await manager.list(cwd);
  const top5 = allSessions.slice(0, 5);

  if (top5.length === 0) {
    console.log(chalk.hex(TEXT_DIM)("No sessions found for this directory."));
    return null;
  }

  // Load first prompt for each session
  const sessions: SessionDisplay[] = await Promise.all(
    top5.map(async (info) => ({
      info,
      firstPrompt: await extractFirstPrompt(info.path),
    })),
  );

  return new Promise((resolve) => {
    let selectedIndex = 0;

    const draw = () => {
      process.stdout.write("\x1b[u\x1b[J" + renderScreen(sessions, selectedIndex) + "\n");
    };

    process.stdout.write("\n\x1b[s");
    draw();

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[u\x1b[J");
    };

    const onData = (chunk: Buffer) => {
      const key = chunk.toString();

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        resolve(null);
        return;
      }

      // Arrow keys (must check before bare escape)
      if (key === "\x1b[A" || key === "\x1bOA") {
        if (selectedIndex > 0) {
          selectedIndex--;
          draw();
        }
        return;
      }

      if (key === "\x1b[B" || key === "\x1bOB") {
        if (selectedIndex < sessions.length - 1) {
          selectedIndex++;
          draw();
        }
        return;
      }

      // Escape (bare \x1b with no following bracket sequence)
      if (key === "\x1b") {
        cleanup();
        resolve(null);
        return;
      }

      // Enter → select
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(sessions[selectedIndex]!.info.path);
        return;
      }

      // q to quit as well
      if (key === "q") {
        cleanup();
        resolve(null);
        return;
      }
    };

    process.stdin.on("data", onData);
  });
}
