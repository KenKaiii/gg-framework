import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import chalk from "chalk";
import type { Provider } from "@kenkaiiii/gg-ai";

const _require = createRequire(import.meta.url);
// This module lives one directory deeper than cli.ts (src/cli/ → dist/cli/),
// so the package manifest is two levels up rather than one.
export const CLI_VERSION = (_require("../../package.json") as { version: string }).version;

// ── Logo + gradient (mirrors Banner.tsx) ────────────────────────────
export const LOGO_LINES = [
  " \u2584\u2580\u2580\u2580 \u2584\u2580\u2580\u2580",
  " \u2588 \u2580\u2588 \u2588 \u2580\u2588",
  " \u2580\u2584\u2584\u2580 \u2580\u2584\u2584\u2580",
];

const GRADIENT = [
  "#60a5fa",
  "#6da1f9",
  "#7a9df7",
  "#8799f5",
  "#9495f3",
  "#a18ff1",
  "#a78bfa",
  "#a18ff1",
  "#9495f3",
  "#8799f5",
  "#7a9df7",
  "#6da1f9",
];

export function gradientLine(text: string): string {
  let result = "";
  let colorIdx = 0;
  for (const ch of text) {
    if (ch === " ") {
      result += ch;
    } else {
      result += chalk.hex(GRADIENT[colorIdx % GRADIENT.length])(ch);
      colorIdx++;
    }
  }
  return result;
}

export function clearVisibleScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

/**
 * Bail with a friendly message if stdin isn't a TTY. Ink's raw-mode crash is
 * cryptic; this catches the common case (piped stdin, API shells, CI).
 */
export function requireInteractiveTTY(): void {
  if (process.stdin.isTTY) return;
  process.stderr.write(
    chalk.red("ggcoder needs an interactive terminal — your stdin isn't a TTY.\n") +
      chalk.hex("#6b7280")(
        "Run ggcoder directly in your terminal (not piped or through an API shell). " +
          'For headless use try "ggcoder --json \'<prompt>\'" or "ggcoder --rpc".\n',
      ),
  );
  process.exit(1);
}

export function displayName(provider: Provider): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "xiaomi") return "Xiaomi (MiMo)";
  if (provider === "gemini") return "Gemini";
  if (provider === "glm") return "Z.AI (GLM)";
  if (provider === "moonshot") return "Moonshot";
  if (provider === "minimax") return "MiniMax";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "openrouter") return "OpenRouter";
  return "OpenAI";
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  execFile(cmd, [url], () => {
    // Ignore errors — user can copy URL manually
  });
}
