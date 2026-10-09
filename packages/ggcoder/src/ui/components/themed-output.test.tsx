// Must stay the first import: sets FORCE_COLOR before ink loads chalk, whose
// color level is fixed at module-evaluation time. See force-color.ts.
import "./force-color.js";
import React from "react";
import { render } from "ink";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ToolExecution } from "./ToolExecution.js";
import { Banner } from "./Banner.js";
import { ThemeContext, loadTheme, type ThemeName } from "../theme/theme.js";
import darkTheme from "../theme/dark.json" with { type: "json" };

vi.mock("../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 100, rows: 30, resizeKey: 0 }),
}));

/**
 * Regression for #3: Banner and ToolExecution rendered hardcoded dark-mode hex
 * colors regardless of the active theme, so light/ansi/daltonized themes got
 * near-invisible output (e.g. #e5e7eb body text on a light background).
 *
 * These tests render both components under every shipped theme and assert the
 * emitted ANSI colors come from that theme's tokens, not a baked-in palette.
 */

/** Convert a 24-bit hex color to the ANSI escape Ink emits for it. */
function fgEscape(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

function bgEscape(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `[48;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

/** Render a node to its raw ANSI output under the given theme. */
function renderThemed(themeName: ThemeName, node: React.ReactNode): string {
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as NodeJS.WriteStream;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.isTTY = true;
  stdout.getColorDepth = () => 24;

  const instance = render(
    <ThemeContext.Provider value={loadTheme(themeName)}>{node}</ThemeContext.Provider>,
    { stdout, patchConsole: false, debug: true },
  );
  instance.unmount();
  return output;
}

const ALL_THEMES: ThemeName[] = [
  "dark",
  "light",
  "dark-ansi",
  "light-ansi",
  "dark-daltonized",
  "light-daltonized",
];

const DIFF_RESULT = [
  "@@ -1,3 +1,3 @@",
  " context line",
  "-const oldValue = 1;",
  "+const newValue = 2;",
].join("\n");

describe("ToolExecution theming", () => {
  it("renders error output in the active theme's error color, not a fixed red", () => {
    for (const name of ALL_THEMES) {
      const theme = loadTheme(name);
      const out = renderThemed(
        name,
        <ToolExecution
          status="done"
          name="bash"
          args={{ command: "false" }}
          result={"Exit code: 1\nboom"}
          isError
        />,
      );
      expect(out).toContain(fgEscape(theme.error));
      // The old hardcoded palette must not leak into non-dark themes.
      if (theme.error !== darkTheme.error) {
        expect(out).not.toContain(fgEscape(darkTheme.error));
      }
    }
  });

  it("colors diff gutters from theme background tokens", () => {
    for (const name of ALL_THEMES) {
      const theme = loadTheme(name);
      const out = renderThemed(
        name,
        <ToolExecution
          status="done"
          name="edit"
          args={{ file_path: "/tmp/a.ts" }}
          result={DIFF_RESULT}
          isError={false}
          details={{ diff: DIFF_RESULT }}
        />,
      );
      expect(out).toContain(bgEscape(theme.diffAddedBackground));
      expect(out).toContain(bgEscape(theme.diffRemovedBackground));
      expect(out).toContain(fgEscape(theme.diffAddedBackgroundText));
    }
  });

  it("syntax-highlights diff code with the active theme's colors on first render", () => {
    for (const name of ALL_THEMES) {
      const theme = loadTheme(name);
      const out = renderThemed(
        name,
        <ToolExecution
          status="done"
          name="edit"
          args={{ file_path: "/tmp/a.ts" }}
          result={DIFF_RESULT}
          isError={false}
          details={{ diff: DIFF_RESULT }}
        />,
      );
      // `const` is an hljs-keyword, which the theme maps to `secondary`.
      expect(out).toContain(`${fgEscape(theme.secondary)}const`);
    }
  });

  it("renders MCP result lines in the theme's primary, warning and muted tokens", () => {
    // mcp__ tools take the default body path, whose line renderer colors
    // file:line:content matches with primary / warning / dim / muted tokens.
    const result = "src/app.ts:42:the matched content here";
    for (const name of ALL_THEMES) {
      const theme = loadTheme(name);
      const out = renderThemed(
        name,
        <ToolExecution
          status="done"
          name="mcp__probe__search"
          args={{ query: "x" }}
          result={result}
          isError={false}
        />,
      );
      expect(out).toContain(fgEscape(theme.primary));
      expect(out).toContain(fgEscape(theme.warning));
      expect(out).toContain(fgEscape(theme.textMuted));
    }
  });
});

describe("Banner theming", () => {
  it("draws the logo gradient from the active theme's primary and secondary", () => {
    for (const name of ALL_THEMES) {
      const theme = loadTheme(name);
      const out = renderThemed(
        name,
        <Banner version="1.0.0" model="gpt-5" provider="openai" cwd="/tmp" />,
      );
      expect(out).toContain(fgEscape(theme.primary));
      if (theme.secondary !== darkTheme.secondary) {
        // Endpoint of the old baked-in dark gradient.
        expect(out).not.toContain(fgEscape(darkTheme.secondary));
      }
    }
  });
});
