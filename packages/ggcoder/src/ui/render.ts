import React from "react";
import { render } from "ink";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import type { MCPClientManager } from "../core/mcp/index.js";
import { App, type CompletedItem } from "./App.js";
import { ThemeContext, loadTheme } from "./theme/theme.js";

export interface RenderAppConfig {
  provider: Provider;
  model: string;
  tools: AgentTool[];
  webSearch?: boolean;
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
  mcpManager?: MCPClientManager;
}

export async function renderApp(config: RenderAppConfig): Promise<void> {
  const theme = loadTheme(config.theme ?? "dark");

  // Clear screen
  process.stdout.write("\x1b[2J\x1b[H");

  const { waitUntilExit, clear } = render(
    React.createElement(
      ThemeContext.Provider,
      { value: theme },
      React.createElement(App, {
        provider: config.provider,
        model: config.model,
        tools: config.tools,
        webSearch: config.webSearch,
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
        mcpManager: config.mcpManager,
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
}
