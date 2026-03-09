import React from "react";
import { render } from "ink";
import type { Message, Provider, ServerToolDefinition, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import { App, type CompletedItem } from "./App.js";
import { SplashScreen } from "./components/SplashScreen.js";
import { ThemeContext, loadTheme } from "./theme/theme.js";
import { MOUSE_DISABLE } from "./hooks/useMouseScroll.js";

export interface RenderAppConfig {
  provider: Provider;
  model: string;
  tools: AgentTool[];
  serverTools?: ServerToolDefinition[];
  messages: Message[];
  maxTokens: number;
  thinking?: ThinkingLevel;
  apiKey?: string;
  baseUrl?: string;
  accountId?: string;
  cwd: string;
  version: string;
  theme?: "dark" | "light";
  showThinking?: boolean;
  showTokenUsage?: boolean;
  onSlashCommand?: (input: string) => Promise<string | null>;
  loggedInProviders?: Provider[];
  credentialsByProvider?: Record<string, { accessToken: string; accountId?: string }>;
  initialHistory?: CompletedItem[];
  sessionsDir?: string;
  sessionPath?: string;
  processManager?: ProcessManager;
  settingsFile?: string;
}

export async function renderApp(config: RenderAppConfig): Promise<void> {
  const theme = loadTheme(config.theme ?? "dark");

  const isRestoredSession = config.initialHistory && config.initialHistory.length > 0;
  const rows = process.stdout.rows ?? 24;

  // Clear screen and set scroll region (DECSTBM) to pin row 1 for the shimmer line
  process.stdout.write(
    "\x1b[2J" + // clear screen
      "\x1b[H" + // cursor to row 1, col 1
      `\x1b[2;${rows}r` + // scroll region: row 2 to bottom
      "\x1b[2;1H", // move cursor to row 2 for Ink
  );

  // Show animated splash screen for new sessions only (skip for restored sessions)
  if (!isRestoredSession) {
    await new Promise<void>((resolve) => {
      const { unmount } = render(
        React.createElement(
          ThemeContext.Provider,
          { value: theme },
          React.createElement(SplashScreen, {
            version: config.version,
            onDone: () => {
              unmount();
              resolve();
            },
          }),
        ),
      );
    });

    // Clear screen for the main app
    process.stdout.write(
      "\x1b[2J" + // clear screen
        "\x1b[H" + // cursor to row 1, col 1
        `\x1b[2;${rows}r` + // scroll region: row 2 to bottom
        "\x1b[2;1H", // move cursor to row 2 for Ink
    );
  }

  const { waitUntilExit, clear } = render(
    React.createElement(
      ThemeContext.Provider,
      { value: theme },
      React.createElement(App, {
        provider: config.provider,
        model: config.model,
        tools: config.tools,
        serverTools: config.serverTools,
        messages: config.messages,
        maxTokens: config.maxTokens,
        thinking: config.thinking,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        accountId: config.accountId,
        cwd: config.cwd,
        version: config.version,
        showThinking: config.showThinking,
        showTokenUsage: config.showTokenUsage,
        onSlashCommand: config.onSlashCommand,
        loggedInProviders: config.loggedInProviders,
        credentialsByProvider: config.credentialsByProvider,
        initialHistory: config.initialHistory,
        sessionsDir: config.sessionsDir,
        sessionPath: config.sessionPath,
        processManager: config.processManager,
        settingsFile: config.settingsFile,
      }),
    ),
    {
      // Enable kitty keyboard protocol so terminals that support it can
      // distinguish Shift+Enter from Enter (needed for multiline input).
      // Terminals without support gracefully ignore this.
      kittyKeyboard: {
        mode: "enabled",
        flags: ["disambiguateEscapeCodes"],
      },
      // Ink's built-in exitOnCtrlC checks for the raw \x03 byte, but with
      // kitty keyboard protocol Ctrl+C arrives as \x1b[99;5u so the check
      // never matches. Worse, useInput skips calling our handler when
      // exitOnCtrlC is true. Disable it so our InputArea handles Ctrl+C.
      exitOnCtrlC: false,
    },
  );

  // Resize handling (terminal clear + Static remount) is done inside the
  // React tree via the useTerminalSize hook, which debounces 300ms then
  // clears screen+scrollback and bumps a resizeKey to force Ink to
  // re-render <Static> content.  The render.ts layer only needs to call
  // clear() so Ink forgets its stale line-count tracking.
  const onResize = () => {
    clear();
  };
  process.stdout.on("resize", onResize);

  await waitUntilExit();

  process.stdout.off("resize", onResize);

  // Reset scroll region, disable mouse tracking, and clear the shimmer line on exit
  process.stdout.write(MOUSE_DISABLE + "\x1b[r\x1b[1;1H\x1b[2K");
}
