import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { Provider } from "@kenkaiiii/gg-ai";

// Resolve the package version by walking up from this module to the nearest
// package.json. A bare `require("../../package.json")` breaks when this module
// is re-bundled into a sibling package (e.g. gg-boss), where the relative path
// no longer points at ggcoder's manifest — so it crashes the CLI. Walking up
// from import.meta.url always finds a valid manifest and never throws.
function resolveCliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        version?: string;
      };
      if (manifest.version) return manifest.version;
    } catch {
      // no package.json at this level — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

export const CLI_VERSION = resolveCliVersion();

// ── Logo + gradient (mirrors terminal-history.ts banner) ────────────
export const LOGO_LINES = [
  " \u2588\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2588\u2557 ",
  "\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d ",
  "\u2588\u2588\u2551  \u2588\u2588\u2588\u2557\u2588\u2588\u2551  \u2588\u2588\u2588\u2557",
  "\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551",
  "\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d",
  " \u255a\u2550\u2550\u2550\u2550\u2550\u255d  \u255a\u2550\u2550\u2550\u2550\u2550\u255d",
];

// Visible width of the logo block (glyph columns) and the gap before titles.
export const LOGO_WIDTH = 17;
export const LOGO_GAP = "   ";
// Row index in the logo block where the title lines begin, so a 3-line title
// block reads vertically centered beside the 6-line art.
export const LOGO_TITLE_ANCHOR_ROW = 1;

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

export function gradientLineWith(text: string, gradient: readonly string[]): string {
  const palette = gradient.length > 0 ? gradient : GRADIENT;
  let result = "";
  let colorIdx = 0;
  for (const ch of text) {
    if (ch === " ") {
      result += ch;
    } else {
      const color = palette[colorIdx % palette.length] ?? palette[0] ?? "#60a5fa";
      result += chalk.hex(color)(ch);
      colorIdx++;
    }
  }
  return result;
}

export function gradientLine(text: string): string {
  return gradientLineWith(text, GRADIENT);
}

/**
 * Render the GG logo with up to three title lines placed beside the
 * vertically-centered rows of the (6-line) art. Returns one string per output
 * row. `titleLines` are already-colored strings (brand, page name, subtitle).
 */
export function renderLogoBlock(
  titleLines: readonly string[],
  options?: { gradient?: readonly string[] },
): string[] {
  const gradient = options?.gradient ?? GRADIENT;
  return LOGO_LINES.map((line, i) => {
    const logo = gradientLineWith(line, gradient);
    const titleIndex = i - LOGO_TITLE_ANCHOR_ROW;
    const title =
      titleIndex >= 0 && titleIndex < titleLines.length ? titleLines[titleIndex] : undefined;
    return title === undefined ? logo : `${logo}${LOGO_GAP}${title}`;
  });
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
  if (provider === "sakana") return "Sakana (Fugu)";
  if (provider === "xai") return "xAI (Grok)";
  return "OpenAI";
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  execFile(cmd, [url], () => {
    // Ignore errors — user can copy URL manually
  });
}
