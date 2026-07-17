import chalk from "chalk";
import type { Provider } from "@kenkaiiii/gg-ai";
import { renderLogoBlock } from "../cli/shared.js";

// Defaults — ggcoder branding. ggeditor passes its own palette.
const DEFAULT_GRADIENT = [
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
const DEFAULT_PRIMARY = "#60a5fa";
const DEFAULT_ACCENT = "#a78bfa";
const TEXT = "#e2e8f0";
const TEXT_DIM = "#64748b";

let _version = "";
let _brand = "GG Coder";
let _gradient: string[] = DEFAULT_GRADIENT;
let _primary = DEFAULT_PRIMARY;
let _accent = DEFAULT_ACCENT;

const PROVIDERS: { label: string; value: Provider; description: string }[] = [
  {
    label: "Anthropic",
    value: "anthropic",
    description: "Claude Fable 5, Opus 4.8, Sonnet 5, Haiku 4.5",
  },
  {
    label: "OpenAI",
    value: "openai",
    description: "GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5",
  },
  {
    label: "Gemini",
    value: "gemini",
    description: "Gemini 3.1 Flash Lite, Gemini 3.5 Flash, Gemini 3.1 Pro (Preview)",
  },
  { label: "xAI (Grok)", value: "xai", description: "Grok 4.5" },
  {
    label: "Moonshot",
    value: "moonshot",
    description: "Kimi K3, K2.7 Code · OAuth or API key",
  },
  { label: "Z.AI (GLM)", value: "glm", description: "GLM-5.2, GLM-5.1, GLM-4.7, GLM-4.7 Flash" },
  { label: "MiniMax", value: "minimax", description: "MiniMax M3" },
  {
    label: "Xiaomi (MiMo)",
    value: "xiaomi",
    description: "MiMo-V2.5-Pro, MiMo-V2.5-Pro-UltraSpeed, MiMo-V2.5 · Token Plan or API Credits",
  },
  { label: "DeepSeek", value: "deepseek", description: "DeepSeek V4 Pro, V4 Flash" },
  { label: "Sakana (Fugu)", value: "sakana", description: "Fugu, Fugu Ultra" },
  { label: "OpenRouter", value: "openrouter", description: "Multi-provider gateway" },
];

function renderScreen(selectedIndex: number): string {
  const lines: string[] = [];

  for (const row of renderLogoBlock(
    [
      chalk.hex(_primary).bold(_brand) +
        (_version ? chalk.hex(TEXT_DIM)(` v${_version}`) : "") +
        chalk.hex(TEXT_DIM)(" · By ") +
        chalk.hex(TEXT).bold("Ken Kai"),
      chalk.hex(_accent)("Login"),
      chalk.hex(TEXT_DIM)("Select a provider"),
    ],
    { gradient: _gradient },
  )) {
    lines.push(row);
  }
  lines.push("");

  for (let i = 0; i < PROVIDERS.length; i++) {
    const item = PROVIDERS[i];
    const selected = i === selectedIndex;
    const marker = selected ? "❯ " : "  ";
    const labelColor = selected ? _primary : TEXT;
    lines.push(
      chalk.hex(labelColor)(marker + item.label) + chalk.hex(TEXT_DIM)(` — ${item.description}`),
    );
  }

  lines.push("");
  lines.push(chalk.hex(TEXT_DIM)("↑↓ navigate · Enter select · Esc cancel"));

  return lines.join("\n");
}

export interface LoginSelectorOptions {
  /** Brand name shown next to the logo (default: "GG Coder"). */
  brand?: string;
  /** Version shown after the brand. */
  version?: string;
  /** Logo gradient (12 colors recommended). Defaults to ggcoder blue/purple. */
  gradient?: string[];
  /** Primary color (brand text + selected provider). */
  primary?: string;
  /** Accent color (subtitle "Login"). */
  accent?: string;
}

export function renderLoginSelector(
  optsOrVersion?: LoginSelectorOptions | string,
): Promise<Provider | null> {
  // Backward compatible: prior signature was `renderLoginSelector(version?)`.
  const opts: LoginSelectorOptions =
    typeof optsOrVersion === "string" ? { version: optsOrVersion } : (optsOrVersion ?? {});
  _version = opts.version ?? "";
  _brand = opts.brand ?? "GG Coder";
  _gradient = opts.gradient && opts.gradient.length > 0 ? opts.gradient : DEFAULT_GRADIENT;
  _primary = opts.primary ?? DEFAULT_PRIMARY;
  _accent = opts.accent ?? DEFAULT_ACCENT;
  return new Promise((resolve) => {
    let selectedIndex = 0;

    const draw = () => {
      // Restore saved cursor position, clear everything below, then draw
      process.stdout.write("\x1b[u\x1b[J" + renderScreen(selectedIndex) + "\n");
    };

    // Save cursor position, then draw
    process.stdout.write("\n\x1b[s");
    draw();

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
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
