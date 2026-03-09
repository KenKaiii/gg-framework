import chalk from "chalk";
import type { Provider } from "@kenkaiiii/gg-ai";
import type { ProviderStatus } from "../core/oauth/types.js";

const LOGO_LINES = [" ▄▀▀▀ ▄▀▀▀", " █ ▀█ █ ▀█", " ▀▄▄▀ ▀▄▄▀"];
const GRADIENT = ["#60a5fa", "#6da1f9", "#7a9df7", "#8799f5", "#9495f3", "#a18ff1", "#a78bfa"];
const GAP = "   ";

const PRIMARY = "#60a5fa";
const TEXT = "#e2e8f0";
const TEXT_DIM = "#64748b";

const PROVIDERS: { label: string; value: Provider; description: string }[] = [
  { label: "Anthropic", value: "anthropic", description: "Claude Opus, Sonnet, Haiku" },
  { label: "OpenAI", value: "openai", description: "GPT-5.3 Codex, GPT-5.1 Codex Mini" },
  { label: "Z.AI (GLM)", value: "glm", description: "GLM-5, GLM-4.7" },
  { label: "Moonshot", value: "moonshot", description: "Kimi K2.5" },
];

function gradientLine(text: string): string {
  let result = "";
  let colorIdx = 0;
  for (const ch of text) {
    if (ch === " ") {
      result += ch;
    } else {
      const color = GRADIENT[Math.min(colorIdx, GRADIENT.length - 1)];
      result += chalk.hex(color)(ch);
      colorIdx++;
    }
  }
  return result;
}

function renderScreen(selectedIndex: number, providerStatuses?: ProviderStatus[]): string {
  const lines: string[] = [];

  lines.push(gradientLine(LOGO_LINES[0]) + GAP + chalk.hex(PRIMARY).bold("Login"));
  lines.push(gradientLine(LOGO_LINES[1]) + GAP + chalk.hex(TEXT_DIM)("Select a provider"));
  lines.push(gradientLine(LOGO_LINES[2]));
  lines.push("");

  if (providerStatuses && providerStatuses.length > 0) {
    for (const ps of providerStatuses) {
      const icon = ps.connected ? chalk.hex("#4ade80")("✓") : chalk.hex("#ef4444")("✗");
      const label = ps.provider.padEnd(10);
      const detail = ps.connected
        ? chalk.hex(TEXT_DIM)(ps.source ?? "connected")
        : chalk.hex(TEXT_DIM)("not connected");
      lines.push(`  ${icon} ${chalk.hex(TEXT)(label)} ${detail}`);
    }
    lines.push("");
  }

  for (let i = 0; i < PROVIDERS.length; i++) {
    const item = PROVIDERS[i];
    const selected = i === selectedIndex;
    const marker = selected ? "❯ " : "  ";
    const labelColor = selected ? PRIMARY : TEXT;
    const isConnected = providerStatuses?.find((ps) => ps.provider === item.value)?.connected;
    const reconnectTag = isConnected ? chalk.hex(TEXT_DIM)(" (reconnect)") : "";
    lines.push(
      chalk.hex(labelColor)(marker + item.label) +
        reconnectTag +
        chalk.hex(TEXT_DIM)(` — ${item.description}`),
    );
  }

  lines.push("");
  lines.push(chalk.hex(TEXT_DIM)("↑↓ navigate · Enter select · Esc cancel"));

  return lines.join("\n");
}

export function renderLoginSelector(providerStatuses?: ProviderStatus[]): Promise<Provider | null> {
  return new Promise((resolve) => {
    let selectedIndex = 0;

    const draw = () => {
      // Restore saved cursor position, clear everything below, then draw
      process.stdout.write("\x1b[u\x1b[J" + renderScreen(selectedIndex, providerStatuses) + "\n");
    };

    // Save cursor position, then draw
    process.stdout.write("\n\x1b[s");
    draw();

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      // Clear the selector display
      process.stdout.write("\x1b[u\x1b[J");
    };

    const onData = (chunk: Buffer) => {
      const key = chunk.toString();

      // Escape or Ctrl+C → cancel
      if (key === "\x1b" || key === "\x03") {
        cleanup();
        resolve(null);
        return;
      }

      // Enter → select
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(PROVIDERS[selectedIndex].value);
        return;
      }

      // Up arrow
      if (key === "\x1b[A" && selectedIndex > 0) {
        selectedIndex--;
        draw();
      }

      // Down arrow
      if (key === "\x1b[B" && selectedIndex < PROVIDERS.length - 1) {
        selectedIndex++;
        draw();
      }
    };

    process.stdin.on("data", onData);
  });
}
