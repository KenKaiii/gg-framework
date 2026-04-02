import React from "react";
import { render } from "ink";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import type { MCPClientManager } from "../core/mcp/index.js";
import type { AuthStorage } from "../core/auth-storage.js";
import type { Skill } from "../core/skills.js";
import type { RemoteControlServer } from "../core/remote-control.js";
import { App, type CompletedItem } from "./App.js";
import { ThemeContext, loadTheme } from "./theme/theme.js";
import { detectTheme } from "./theme/detect-theme.js";
import { AnimationProvider } from "./components/AnimationContext.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";

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
  theme?: "auto" | "dark" | "light";
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
  authStorage?: AuthStorage;
  planModeRef?: { current: boolean };
  onEnterPlanRef?: { current: (reason?: string) => void };
  onExitPlanRef?: { current: (planPath: string) => Promise<string> };
  skills?: Skill[];
  remoteControl?: RemoteControlServer;
}

export async function renderApp(config: RenderAppConfig): Promise<void> {
  const themeSetting = config.theme ?? "auto";
  const resolvedTheme = themeSetting === "auto" ? await detectTheme() : themeSetting;
  const theme = loadTheme(resolvedTheme);

  // Clear screen + scrollback so old commands don't appear above the TUI
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  const { waitUntilExit, clear } = render(
    React.createElement(
      ThemeContext.Provider,
      { value: theme },
      React.createElement(
        TerminalSizeProvider,
        null,
        React.createElement(
          AnimationProvider,
          null,
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
            authStorage: config.authStorage,
            planModeRef: config.planModeRef,
            onEnterPlanRef: config.onEnterPlanRef,
            onExitPlanRef: config.onExitPlanRef,
            skills: config.skills,
            remoteControl: config.remoteControl,
          }),
        ),
      ),
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

  // Resize handling: debounce Ink's clear() so it only fires once after the
  // user finishes dragging.  Previously clear() fired on every resize event
  // (many per drag), causing Ink to lose its line tracking and re-render the
  // live area at new positions — leaving ghost/duplicate copies in scrollback.
  // The React-side useTerminalSize hook handles screen clearing and Static
  // remount via its own 300ms debounce + resizeKey bump.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      clear();
    }, 300);
  };
  process.stdout.on("resize", onResize);

  await waitUntilExit();

  process.stdout.off("resize", onResize);
  if (resizeTimer) clearTimeout(resizeTimer);
}
