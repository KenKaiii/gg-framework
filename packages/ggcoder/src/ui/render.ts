import React from "react";
import { render, type Instance as InkInstance } from "ink";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import type { MCPClientManager } from "../core/mcp/index.js";
import type { AuthStorage } from "../core/auth-storage.js";
import type { Skill } from "../core/skills.js";
import { App, type CompletedItem } from "./App.js";
import type { PlanStep } from "../utils/plan-steps.js";
import { ThemeContext, SetThemeContext, loadTheme, type ThemeName } from "./theme/theme.js";
import { detectTheme } from "./theme/detect-theme.js";
import { AnimationProvider } from "./components/AnimationContext.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
// Note: DEC 2026 synchronized output (BSU/ESU) is handled natively by Ink 6.8+
// via its built-in write-synchronized.ts module — no manual wrapping needed.

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
  theme?: "auto" | ThemeName;
  showThinking?: boolean;
  showTokenUsage?: boolean;
  onSlashCommand?: (input: string) => Promise<string | null>;
  loggedInProviders?: Provider[];
  credentialsByProvider?: Record<
    string,
    { accessToken: string; accountId?: string; baseUrl?: string }
  >;
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
  initialOverlay?: "pixel";
  rebuildToolsForCwd?: (cwd: string) => AgentTool[];
}

/**
 * Runtime UI choices that survive every unmount/remount (including `/clear`).
 * Lives in `renderApp`'s closure so the user's model/provider/thinking
 * picks aren't lost when an overlay close, plan accept, etc. tears down
 * the React tree.
 */
interface RuntimeState {
  model: string;
  provider: Provider;
  thinking?: ThinkingLevel;
}

/**
 * Session state that needs to survive unmount/remount for paths that
 * KEEP the conversation (overlay close, plan reject) — and which we
 * deliberately wipe for paths that start a fresh session (`/clear`,
 * plan accept, startTask, pixel fix).
 *
 * App.tsx mirrors its in-React state into this object via useEffects,
 * so when `resetUI` rebuilds the Ink instance, the new App can re-seed
 * from the latest snapshot. This is the price of using unmount/remount
 * as our reset mechanism (the only thing that actually escapes Ink's
 * cumulative live-area drift).
 */
type OverlayKind = "model" | "tasks" | "skills" | "plan" | "theme" | "eyes" | "pixel" | null;

export interface SessionStore {
  messages: Message[];
  history: CompletedItem[];
  approvedPlanPath?: string;
  planSteps: PlanStep[];
  sessionPath?: string;
  sessionTitle?: string;
  sessionTitleGenerated: boolean;
  /** Which overlay (Tasks, Skills, Plan, Pixel, Eyes, Theme, Model) is open. */
  overlay?: OverlayKind;
  /** Plan overlay auto-expand-newest flag (only meaningful when overlay==='plan'). */
  planAutoExpand?: boolean;
  /**
   * "Run all" chained-execution flags. Persist across the unmount/remount
   * triggered by `startTask` / `startPixelFix` (each task gets a fresh
   * session via `wipeSession: true`). Without persistence, the new App
   * boots with `useState(false)` and the chain dies after task #1.
   * Deliberately NOT cleared by `wipeSession` — the whole point is for
   * them to span per-task resets.
   */
  runAllTasks?: boolean;
  runAllPixel?: boolean;
  /**
   * Action to run on the next mount (consumed once). Used by paths that
   * remount AND immediately drive the agent — plan accept / reject,
   * startTask, etc. The new App reads this on mount, fires the agent,
   * and clears the field.
   */
  pendingAction?: { prompt: string; infoText?: string };
}

export interface ResetUIOptions {
  /** Replace messages entirely (e.g. fresh system prompt for `/clear` or plan accept). */
  messages?: Message[];
  /** Wipe history, plan steps, session metadata. Applied BEFORE other fields. */
  wipeSession?: boolean;
  /** Replace history outright (applied AFTER wipeSession). */
  history?: CompletedItem[];
  /** Set the approved plan path on the new mount. */
  approvedPlanPath?: string;
  /** Set plan steps (e.g. parsed from the freshly approved plan). */
  planSteps?: PlanStep[];
  /** Override session path (e.g. plan accept creates a new session file). */
  sessionPath?: string;
  /** Action to fire on the new mount (info banner + agent prompt). */
  pendingAction?: { prompt: string; infoText?: string };
}

/** Stateful theme provider — enables runtime theme switching via useSetTheme(). */
function ThemeProvider({
  initial,
  children,
}: React.PropsWithChildren<{
  initial: ThemeName;
}>) {
  const [themeName, setThemeName] = React.useState(initial);
  const theme = React.useMemo(() => loadTheme(themeName), [themeName]);
  const setTheme = React.useCallback((name: ThemeName) => setThemeName(name), []);

  return React.createElement(
    SetThemeContext.Provider,
    { value: setTheme },
    React.createElement(ThemeContext.Provider, { value: theme }, children),
  );
}

const INK_OPTIONS = {
  // Enable kitty keyboard protocol so terminals that support it can
  // distinguish Shift+Enter from Enter (needed for multiline input).
  // Terminals without support gracefully ignore this.
  kittyKeyboard: {
    mode: "enabled" as const,
    flags: ["disambiguateEscapeCodes" as const],
  },
  // Ink's built-in exitOnCtrlC checks for the raw \x03 byte, but with
  // kitty keyboard protocol Ctrl+C arrives as \x1b[99;5u so the check
  // never matches. Worse, useInput skips calling our handler when
  // exitOnCtrlC is true. Disable it so our InputArea handles Ctrl+C.
  exitOnCtrlC: false,
};

export async function renderApp(config: RenderAppConfig): Promise<void> {
  const themeSetting = config.theme ?? "auto";
  const resolvedTheme = themeSetting === "auto" ? await detectTheme() : themeSetting;

  // Clear screen + scrollback so old commands don't appear above the TUI
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  // Runtime state lives in this closure so unmount/remount doesn't lose
  // the user's runtime model/provider/thinking choices.
  const runtimeState: RuntimeState = {
    model: config.model,
    provider: config.provider,
    thinking: config.thinking,
  };

  const onRuntimeStateChange = (updates: Partial<RuntimeState>): void => {
    Object.assign(runtimeState, updates);
  };

  // Session state — App mirrors its React state here via useEffects, so
  // remounts (overlay close, plan reject) can re-seed from the snapshot
  // without losing the conversation.
  const sessionStore: SessionStore = {
    messages: config.messages,
    history: config.initialHistory ?? [{ kind: "banner", id: "banner" }],
    approvedPlanPath: undefined,
    planSteps: [],
    sessionPath: config.sessionPath,
    sessionTitle: undefined,
    sessionTitleGenerated: false,
    overlay: config.initialOverlay ?? null,
    planAutoExpand: false,
    runAllTasks: false,
    runAllPixel: false,
    pendingAction: undefined,
  };

  const ref: { instance: InkInstance | null } = { instance: null };

  const buildElement = (): React.ReactElement =>
    React.createElement(
      ThemeProvider,
      { initial: resolvedTheme },
      React.createElement(
        TerminalSizeProvider,
        null,
        React.createElement(
          AnimationProvider,
          null,
          React.createElement(App, {
            provider: runtimeState.provider,
            model: runtimeState.model,
            tools: config.tools,
            webSearch: config.webSearch,
            messages: sessionStore.messages,
            maxTokens: config.maxTokens,
            thinking: runtimeState.thinking,
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
            initialHistory: sessionStore.history,
            sessionsDir: config.sessionsDir,
            sessionPath: sessionStore.sessionPath,
            processManager: config.processManager,
            settingsFile: config.settingsFile,
            mcpManager: config.mcpManager,
            authStorage: config.authStorage,
            planModeRef: config.planModeRef,
            onEnterPlanRef: config.onEnterPlanRef,
            onExitPlanRef: config.onExitPlanRef,
            skills: config.skills,
            initialOverlay: config.initialOverlay,
            rebuildToolsForCwd: config.rebuildToolsForCwd,
            resetUI,
            onRuntimeStateChange,
            sessionStore,
          }),
        ),
      ),
    );

  // Nuke-and-rebuild for every path that clears the screen. Patching Ink's
  // internal frame tracking (log-update reset, lastOutput cleared,
  // fullStaticOutput dropped) looks correct for one frame but the live area
  // drifts on subsequent streaming responses — Ink's cursor math depends on
  // terminal-state assumptions that ANSI clearing breaks. The only RELIABLE
  // reset is to tear down the React tree entirely and render a fresh Ink
  // instance. gg-boss arrived at the same conclusion (orchestrator-app.tsx).
  function resetUI(options?: ResetUIOptions): void {
    const old = ref.instance;
    if (!old) return;

    if (options?.wipeSession) {
      // Wipe everything session-scoped FIRST. Other options below can then
      // re-seed specific fields (e.g. plan accept wipes the chat then sets
      // approvedPlanPath + planSteps for the implementation phase).
      sessionStore.history = [{ kind: "banner", id: "banner" }];
      sessionStore.approvedPlanPath = undefined;
      sessionStore.planSteps = [];
      sessionStore.sessionTitle = undefined;
      sessionStore.sessionTitleGenerated = false;
    }
    if (options?.messages) sessionStore.messages = options.messages;
    if (options?.history) sessionStore.history = options.history;
    if (options?.approvedPlanPath !== undefined) {
      sessionStore.approvedPlanPath = options.approvedPlanPath;
    }
    if (options?.planSteps !== undefined) sessionStore.planSteps = options.planSteps;
    if (options?.sessionPath !== undefined) sessionStore.sessionPath = options.sessionPath;
    if (options?.pendingAction) sessionStore.pendingAction = options.pendingAction;

    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    old.unmount();
    ref.instance = render(buildElement(), INK_OPTIONS);
  }

  ref.instance = render(buildElement(), INK_OPTIONS);

  // Terminal resize → full unmount/remount. The TerminalSizeProvider hook
  // already debounces resize and writes a screen clear at the end of a
  // drag, but that doesn't reset Ink's log-update internal line-count
  // tracking — so on the very next render the live area is positioned
  // against stale cursor state and the input box ends up pinned to the top
  // of the viewport with new chat lines disappearing off-screen. Same
  // symptom /clear hit; same fix — tear down the React tree and start
  // fresh. Debounced 250ms (shorter than the hook's 300ms) so resetUI wins
  // the race; the hook's pending timer is cancelled by its own useEffect
  // cleanup when the old instance unmounts.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const onTerminalResize = (): void => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      resetUI();
    }, 250);
  };
  process.stdout.on("resize", onTerminalResize);

  // Loop: when /clear remounts, the OLD instance's waitUntilExit resolves
  // (because unmount() resolves it). We then need to wait on the NEW
  // instance. If exit was final (no replacement), ref.instance is nulled
  // by unmount and the loop ends.
  try {
    while (true) {
      const current: InkInstance | null = ref.instance;
      if (!current) return;
      await current.waitUntilExit();
      if (ref.instance === current) {
        ref.instance = null;
        return;
      }
    }
  } finally {
    process.stdout.off("resize", onTerminalResize);
    if (resizeTimer) clearTimeout(resizeTimer);
  }
}
