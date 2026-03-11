import { createContext, useContext } from "react";
import fs from "node:fs";
import darkTheme from "./dark.json" with { type: "json" };
import lightTheme from "./light.json" with { type: "json" };

export type Theme = typeof darkTheme;
export type ThemeName = "dark" | "light" | "auto";

/**
 * Detect whether the terminal is using a light or dark background.
 *
 * Checks (in order):
 * 1. COLORFGBG env var — set by some terminals (rxvt, xterm, some iTerm2 configs).
 * 2. OSC 11 query — asks the terminal its actual background colour via /dev/tty.
 *    Works with iTerm2, kitty, Alacritty, WezTerm, Warp, macOS Terminal, VS Code
 *    terminal, and most modern terminal emulators.
 * 3. Falls back to "dark" (safe default for developer terminals).
 *
 * Note: macOS AppleInterfaceStyle is intentionally NOT checked — it reflects
 * the OS-level appearance, not the terminal's actual background colour.
 */
export function detectTerminalTheme(): "dark" | "light" {
  // 1. COLORFGBG — reliable when set
  const colorFgBg = process.env.COLORFGBG;
  if (colorFgBg) {
    const parts = colorFgBg.split(";");
    const bg = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(bg)) {
      return bg >= 7 ? "light" : "dark";
    }
  }

  // 2. OSC 11 — query the terminal directly for its background colour
  const osc11 = queryTerminalBackground();
  if (osc11 !== null) {
    return osc11;
  }

  // 3. Safe default
  return "dark";
}

/**
 * Query the terminal's background colour using the OSC 11 escape sequence.
 *
 * Sends `ESC ] 11 ; ? BEL` to /dev/tty and reads the response, which is
 * `ESC ] 11 ; rgb:RRRR/GGGG/BBBB ST` where the RGB values are hex.
 *
 * Uses synchronous /dev/tty file descriptor operations so it works before
 * Ink takes over stdin. Times out after 200ms if the terminal doesn't respond.
 */
function queryTerminalBackground(): "dark" | "light" | null {
  let fd: number | null = null;

  try {
    // Open /dev/tty directly — works even when stdin is piped
    fd = fs.openSync("/dev/tty", fs.constants.O_RDWR);

    // Save terminal state and switch to raw mode
    const { execSync } = require("node:child_process");
    const savedStty = execSync("stty -g < /dev/tty 2>/dev/null", {
      encoding: "utf-8",
      timeout: 500,
    }).trim();

    try {
      // Raw mode: no echo, no line buffering, read returns immediately
      execSync("stty raw -echo < /dev/tty 2>/dev/null", { timeout: 500 });

      // Send OSC 11 query: ESC ] 11 ; ? BEL
      const query = Buffer.from("\x1b]11;?\x07");
      fs.writeSync(fd, query);

      // Read response with timeout — poll for data
      const buf = Buffer.alloc(64);
      let response = "";
      const deadline = Date.now() + 200;

      while (Date.now() < deadline) {
        try {
          const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
          if (bytesRead > 0) {
            response += buf.toString("latin1", 0, bytesRead);
            // Check if we have the full response (ends with BEL or ST)
            if (response.includes("\x07") || response.includes("\x1b\\")) {
              break;
            }
          }
        } catch {
          break;
        }
      }

      // Restore terminal state
      execSync(`stty ${savedStty} < /dev/tty 2>/dev/null`, { timeout: 500 });

      // Parse: ESC ] 11 ; rgb:RRRR/GGGG/BBBB BEL
      const match = response.match(/rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
      if (match) {
        const normalize = (hex: string) =>
          parseInt(hex, 16) / (hex.length <= 2 ? 255 : 65535);
        const r = normalize(match[1]);
        const g = normalize(match[2]);
        const b = normalize(match[3]);

        // Perceived luminance (ITU-R BT.709)
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return luminance > 0.5 ? "light" : "dark";
      }
    } catch {
      // Restore terminal state on any error
      try {
        execSync(`stty ${savedStty} < /dev/tty 2>/dev/null`, { timeout: 500 });
      } catch {
        // Best effort restore
      }
    }
  } catch {
    // /dev/tty not available (e.g. CI, Docker, piped)
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  return null;
}

export function loadTheme(name: ThemeName): Theme {
  const resolved = name === "auto" ? detectTerminalTheme() : name;
  return resolved === "light" ? lightTheme : darkTheme;
}

export const ThemeContext = createContext<Theme>(darkTheme);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
