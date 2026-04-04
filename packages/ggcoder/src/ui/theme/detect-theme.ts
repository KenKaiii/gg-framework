import { execFileSync } from "node:child_process";

/**
 * Detect whether the terminal uses a dark or light background.
 *
 * Detection chain (first match wins):
 * 1. VSCODE_THEME_KIND env var (VS Code integrated terminal)
 * 2. macOS system dark mode (defaults read -g AppleInterfaceStyle)
 * 3. OSC 11 escape sequence query (most modern terminals)
 * 4. COLORFGBG env var (rxvt, some other terminals)
 * 5. Default to "dark"
 */
export async function detectTheme(): Promise<"dark" | "light"> {
  // 1. VS Code sets this reliably
  const vscodeTheme = process.env["VSCODE_THEME_KIND"];
  if (vscodeTheme) {
    return vscodeTheme.includes("light") ? "light" : "dark";
  }

  // 2. macOS system dark mode — fast, no escape-sequence side effects
  if (process.platform === "darwin") {
    try {
      const result = execFileSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
        encoding: "utf-8",
        timeout: 500,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return result.trim().toLowerCase() === "dark" ? "dark" : "light";
    } catch {
      // Command fails when in light mode (key doesn't exist) — that means light
      return "light";
    }
  }

  // 3. OSC 11 — query actual terminal background color
  const osc = await queryOSC11();
  if (osc !== null) return osc;

  // 4. COLORFGBG — "fg;bg" ANSI color indices
  const colorfgbg = process.env["COLORFGBG"];
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bg = parseInt(parts[parts.length - 1]!, 10);
    if (!isNaN(bg)) {
      // ANSI colors: 0-6 and 8 are dark, 7 and 9-15 are light
      return bg === 7 || (bg >= 9 && bg <= 15) ? "light" : "dark";
    }
  }

  // 5. Default
  return "dark";
}

/**
 * Send OSC 11 query to the terminal and parse the background color response.
 * Returns "dark" | "light" based on luminance, or null if unsupported.
 *
 * Note: does NOT send the ESC[6n cursor position sentinel — that response
 * (ESC[row;colR) can leak into stdin if not drained before Ink takes over,
 * causing "[2;1R" to appear in the chat input. Instead we rely on a simple
 * timeout to detect unsupported terminals.
 */
// ESC character built without a literal escape so ESLint's no-control-regex is satisfied
const ESC = String.fromCharCode(27);
const oscResponsePattern = new RegExp(
  ESC + "\\]11;rgb:([0-9a-fA-F]+)/([0-9a-fA-F]+)/([0-9a-fA-F]+)",
);

function queryOSC11(): Promise<"dark" | "light" | null> {
  return new Promise((resolve) => {
    // Skip for multiplexers — they don't forward OSC queries
    const term = process.env["TERM"] ?? "";
    if (term.startsWith("screen") || term.startsWith("tmux")) {
      resolve(null);
      return;
    }

    // Need a real TTY
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(null);
      return;
    }

    const wasRaw = process.stdin.isRaw;
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener("data", onData);
      try {
        process.stdin.setRawMode(wasRaw);
      } catch {
        // ignore
      }
      if (!wasRaw) {
        try {
          process.stdin.pause();
        } catch {
          // ignore
        }
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 200);

    const onData = (data: Buffer) => {
      const str = data.toString();

      // Look for OSC 11 response: ESC]11;rgb:RRRR/GGGG/BBBB followed by BEL or ST
      const match = str.match(oscResponsePattern);
      if (match) {
        clearTimeout(timeout);
        cleanup();

        // Parse RGB values (can be 1, 2, or 4 hex digits per channel)
        const r = normalizeChannel(match[1]!);
        const g = normalizeChannel(match[2]!);
        const b = normalizeChannel(match[3]!);

        // Relative luminance (ITU-R BT.709)
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        resolve(luminance < 0.5 ? "dark" : "light");
      }
    };

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);

      // Send only the OSC 11 query — no ESC[6n sentinel to avoid
      // cursor position responses leaking into Ink's input
      process.stdout.write("\x1b]11;?\x1b\\");
    } catch {
      clearTimeout(timeout);
      cleanup();
      resolve(null);
    }
  });
}

/** Normalize a hex color channel (1-4 hex digits) to 0.0–1.0 range. */
function normalizeChannel(hex: string): number {
  const value = parseInt(hex, 16);
  switch (hex.length) {
    case 1:
      return value / 0xf;
    case 2:
      return value / 0xff;
    case 4:
      return value / 0xffff;
    default:
      return value / (Math.pow(16, hex.length) - 1);
  }
}
