import React from "react";
import wrapAnsi from "wrap-ansi";
import { log } from "@kenkaiiii/gg-core";
import { render, type Instance as InkInstance } from "ink";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import type { SubAgentManager } from "../core/subagent-manager.js";
import type { MCPClientManager } from "../core/mcp/index.js";
import type { AuthStorage } from "../core/auth-storage.js";
import type { Skill } from "../core/skills.js";
import type { CheckpointStore } from "../core/checkpoint-store.js";
import type { LspManager } from "../core/lsp/manager.js";
import type { ReviewCoverageTracker } from "../core/ideal-review.js";
import type { TurnMetricPayload } from "../core/session-manager.js";
import { App, type CompletedItem, type DoneStatus } from "./App.js";
import { itemHasImagePreviews } from "./app-items.js";
import { createTerminalHistoryPrinter } from "./terminal-history.js";
import type { PlanStep } from "../utils/plan-steps.js";
import { ThemeContext, SetThemeContext, loadTheme, type ThemeName } from "./theme/theme.js";
import { detectTheme } from "./theme/detect-theme.js";
import { AnimationProvider } from "./components/AnimationContext.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
// Note: DEC 2026 synchronized output (BSU/ESU) is handled natively by Ink 6.8+
// via its built-in write-synchronized.ts module — no manual wrapping needed.

/**
 * Our `patches/ink@6.8.0.patch` exposes `insertBeforeFrame` on the Ink instance:
 * raw bytes queued through it are folded atomically into the NEXT frame write
 * (erase old frame + scrollback bytes + new frame in one synchronized write).
 * This is the primitive that keeps the footer pinned when finalized transcript
 * rows leave the live frame — the shrink and the scrollback insert land together.
 */
type PatchedInkInstance = InkInstance & {
  insertBeforeFrame?: (data: string) => void;
  /** Toggle bottom-anchor pad creation (on while the agent runs). */
  setFrameAnchorActive?: (active: boolean) => void;
  /** Install the transcript-tail provider for bottom-pinned idle shrink. */
  setFrameShrinkBackfill?: (fn: (rows: number) => string | undefined) => void;
};

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
  projectId?: string;
  cwd: string;
  version: string;
  theme?: "auto" | ThemeName;
  showTokenUsage?: boolean;
  idealReviewEnabled?: boolean;
  onSlashCommand?: (input: string) => Promise<string | null>;
  loggedInProviders?: Provider[];
  credentialsByProvider?: Record<
    string,
    { accessToken: string; accountId?: string; projectId?: string; baseUrl?: string }
  >;
  initialHistory?: CompletedItem[];
  initialTurnMetrics?: TurnMetricPayload[];
  sessionsDir?: string;
  sessionPath?: string;
  sessionId?: string;
  processManager?: ProcessManager;
  subAgentManager?: SubAgentManager;
  lspManager?: LspManager;
  reviewCoverageTracker?: ReviewCoverageTracker;
  settingsFile?: string;
  mcpManager?: MCPClientManager;
  authStorage?: AuthStorage;
  planModeRef?: { current: boolean };
  skills?: Skill[];
  checkpointStore?: CheckpointStore;
  rebuildReadTool?: (model: string) => AgentTool;
  connectInitialMcpTools?: () => Promise<AgentTool[]>;
  onRuntimeStateChange?: (updates: Partial<RuntimeState>) => void;
  planCallbacks?: {
    onEnterPlan?: (reason?: string) => void | Promise<void>;
    onExitPlan?: (planPath: string) => Promise<string>;
  };
}

/**
 * Runtime UI choices that survive every unmount/remount (including `/clear`).
 * Lives in `renderApp`'s closure so the user's model/provider/thinking
 * picks aren't lost when an overlay close, plan accept, etc. tears down
 * the React tree.
 */
export interface RuntimeState {
  model: string;
  provider: Provider;
  thinking?: ThinkingLevel;
}

/**
 * Session state that needs to survive unmount/remount for paths that
 * KEEP the conversation (overlay close, plan reject) — and which we
 * deliberately wipe for paths that start a fresh session (`/clear`,
 * plan accept).
 *
 * App.tsx mirrors its in-React state into this object via useEffects,
 * so when `resetUI` rebuilds the Ink instance, the new App can re-seed
 * from the latest snapshot. This is the price of using unmount/remount
 * as our reset mechanism (the only thing that actually escapes Ink's
 * cumulative live-area drift).
 */
type OverlayKind = "model" | "skills" | "plan" | "theme" | null;

export interface SessionStore {
  messages: Message[];
  history: CompletedItem[];
  turnMetrics?: TurnMetricPayload[];
  /** Live, not-yet-flushed rows that must survive overlay/resize remounts. */
  liveItems?: CompletedItem[];
  /** Transient completion footer (e.g. "✻ Mulled it over for 3s") that is still visible. */
  doneStatus?: DoneStatus | null;
  approvedPlanPath?: string;
  planSteps: PlanStep[];
  sessionPath?: string;
  sessionId?: string;
  /** Which overlay (Skills, Plan, Theme, Model) is open. */
  overlay?: OverlayKind;
  /** Plan overlay auto-expand-newest flag (only meaningful when overlay==='plan'). */
  planAutoExpand?: boolean;
  /**
   * Action to run on the next mount (consumed once). Used by paths that
   * remount AND immediately drive the agent — plan accept / reject,
   * etc. The new App reads this on mount, fires the agent,
   * and clears the field.
   */
  pendingAction?: {
    prompt: string;
    infoText?: string;
    /** Structured event for the post-resetUI banner — renders as a styled
     *  plan_event item instead of the bland info row. */
    planEvent?: { event: "approved" | "rejected" | "dismissed"; detail?: string };
  };
  /**
   * True while the agent loop is running. Mirrored by App.tsx so renderApp's
   * resize handler can skip the unmount/remount that would abort the agent
   * (useAgentLoop's unmount cleanup calls abortRef.abort()).
   */
  isAgentRunning?: boolean;
  /**
   * Set whenever a path that would normally `resetUI()` had to fall back to
   * an in-place update because the agent was running (resize, overlay open/
   * close). Consumed by App.tsx when the agent goes idle: a deferred
   * resetUI() runs to clean up any log-update drift that accumulated during
   * the run. The setTimeout delay lets onDone's two-phase flush commit to
   * sessionStore.history before the unmount, so the chat isn't lost.
   */
  pendingResetUI?: boolean;
  /** Plan mode display/restriction state. */
  planMode?: boolean;
  /** Whether pre-final ideal review is enabled for this UI session. */
  idealReviewEnabled?: boolean;
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
  /** Clear malformed live frames after terminal resize and redraw durable history. */
  resizeRedraw?: boolean;
  /** Action to fire on the new mount (info banner + agent prompt). */
  pendingAction?: {
    prompt: string;
    infoText?: string;
    /** Structured event for the post-resetUI banner — renders as a styled
     *  plan_event item instead of the bland info row. */
    planEvent?: { event: "approved" | "rejected" | "dismissed"; detail?: string };
  };
}

/** Stateful theme provider — enables runtime theme switching via useSetTheme(). */
function ThemeProvider({
  initial,
  onThemeChange,
  children,
}: React.PropsWithChildren<{
  initial: ThemeName;
  /** Mirror theme switches into renderApp's closure (see currentThemeName). */
  onThemeChange?: (name: ThemeName) => void;
}>) {
  const [themeName, setThemeName] = React.useState(initial);
  const theme = React.useMemo(() => loadTheme(themeName), [themeName]);
  const setTheme = React.useCallback(
    (name: ThemeName) => {
      onThemeChange?.(name);
      setThemeName(name);
    },
    [onThemeChange],
  );

  return React.createElement(
    SetThemeContext.Provider,
    { value: setTheme },
    React.createElement(ThemeContext.Provider, { value: theme }, children),
  );
}

const INK_OPTIONS = {
  // [gg ink patch] Scrollback-mode safety net: clip frames to terminal height
  // (rows - 2) so a single mis-estimated live-area clamp can never produce a
  // frame that reaches the screen height. Once a frame hits `rows`, Ink's
  // eraseLines clamps at the screen top on the next shrink and rewrites the
  // frame top-anchored — stranding the footer mid-screen with blank rows
  // below. The clip drops the oldest (top) rows, mirroring the app's own
  // bottom-anchored clamp. The fullscreen alt-screen path must NOT set this —
  // it intentionally owns the whole screen.
  clipFrameToTerminalHeight: true,
  // [gg ink patch] Bottom anchoring: the frame bottom (footer) must never move
  // UP. Any rewrite that nets fewer rows than the previous frame (shrink not
  // fully compensated by enqueued scrollback bytes — tool panel hiding, status
  // row swaps, turn finalization after mid-stream flushes) is padded with
  // blank scrollback lines between the transcript and the frame, keeping the
  // footer row fixed. Exact line counts inside Ink — no estimates, no lag.
  anchorFrameToBottom: true,
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

// Fullscreen alt-screen render tuning. Two settings work together to make
// scrolling smooth instead of jumpy/flickery:
//
//  - incrementalRendering: Ink's default "standard" renderer erases ALL of the
//    previous frame's lines (ansiEscapes.eraseLines) and rewrites the whole
//    frame every tick. For a full-height fullscreen frame that means redrawing
//    the footer/input/status rows — which never change during a scroll — on
//    every step, and that erase-then-refill is the visible flicker. Ink's
//    incremental renderer rewrites ONLY the lines that actually changed (the
//    transcript region), leaving the controls untouched. No erase pass = no
//    flicker. It also has explicit handling for the no-trailing-newline
//    fullscreen frame, so it's the intended mode for this layout.
//
//    NOTE: incremental rendering is fullscreen-ONLY. In the default scrollback
//    path it desyncs against writeToStdout's log.clear()/scrollback flushes —
//    the renderer's line cache no longer matches the terminal, so the input
//    row gets re-emitted instead of diffed and the prompt duplicates down the
//    screen. Keep it out of INK_OPTIONS.
//
//  - maxFps: the default 30fps cap (~33ms/frame) makes the coalesced scroll
//    updates feel stepped. A higher cap lets paints keep up for a smooth glide;
//    combined with incremental rendering each paint is cheap (only the changed
//    rows are written). Ink wraps each frame in synchronized output (BSU/ESU)
//    on a TTY, so higher fps doesn't tear.
//
// The legacy scrollback path keeps the conservative defaults (it appends to
// native scrollback, so there's no repaint to optimize).
const FULLSCREEN_INK_OPTIONS = {
  ...INK_OPTIONS,
  // Fullscreen frames legitimately fill the terminal — never clip or pad them.
  clipFrameToTerminalHeight: false,
  anchorFrameToBottom: false,
  maxFps: 120,
  incrementalRendering: true,
};

// XTMODKEYS "off" — turns off xterm's modifyOtherKeys=2 mode where Shift+Enter,
// Ctrl+letters, etc. arrive as ESC[27;<mod>;<keycode>~. Some terminals
// (Terminal.app, tmux passthrough, certain xterm configs) leave this enabled
// by default, which conflicts with the kitty keyboard protocol we enable
// above — both modes overlap and the raw CSI 27 bytes leak into Ink's text
// input. Writing this at startup (and on each screen clear) matches the
// pattern used by openai/codex (keyboard_modes.rs) and google-gemini/gemini-cli
// (terminal.ts), which both disable modifyOtherKeys immediately before
// enabling kitty enhancement flags. Cleared again on exit so we don't leave
// the terminal in an unusual state.
const DISABLE_MODIFY_OTHER_KEYS = "\x1b[>4;0m";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const SCREEN_CLEAR = DISABLE_MODIFY_OTHER_KEYS + "\x1b[2J\x1b[3J\x1b[H";
const VIEWPORT_CLEAR = DISABLE_MODIFY_OTHER_KEYS + "\x1b[2J\x1b[H";
// Alternate screen buffer (smcup/rmcup). Entering gives a fresh blank screen
// with no native scrollback, so nothing can ever scroll Ink's live frame —
// this is what makes the footer a truly fixed bottom region. Leaving restores
// the user's original shell screen + scrollback intact.
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_LEAVE = "\x1b[?1049l";

/**
 * Fullscreen alternate-screen viewport mode. Default OFF: native terminal
 * scrollback is the default (smooth, GPU-accelerated, real mouse-wheel scroll).
 * Set `GG_FULLSCREEN=1` to opt into the alternate-screen in-Ink viewport
 * (pinned footer, but no native scrollback). Non-TTY / CI / print modes never
 * use it.
 */
export function isFullscreenViewportEnabled(): boolean {
  if (process.env.GG_FULLSCREEN === "1") {
    return Boolean(process.stdout.isTTY && process.stdin.isTTY);
  }
  return false;
}

export function getResetClearMode(
  options: Pick<ResetUIOptions, "wipeSession" | "history" | "resizeRedraw"> | undefined,
): "screen" | "viewport" {
  return options?.wipeSession || options?.history || options?.resizeRedraw ? "screen" : "viewport";
}

export async function renderApp(config: RenderAppConfig): Promise<void> {
  const themeSetting = config.theme ?? "auto";
  const resolvedTheme = themeSetting === "auto" ? await detectTheme() : themeSetting;
  // Live theme tracker — updated by ThemeProvider on every /theme switch.
  // Closure-level serializers (shrink backfill, resize redraw) must use THIS,
  // not the startup `resolvedTheme`, or post-switch repaints redraw the
  // transcript in the old theme's colors. Same staleness class as the
  // sessionStore.history mirror.
  let currentThemeName: ThemeName = resolvedTheme;
  const fullscreen = isFullscreenViewportEnabled();

  // Clear screen + scrollback so old commands don't appear above the TUI.
  // Also disables modifyOtherKeys (see DISABLE_MODIFY_OTHER_KEYS). In fullscreen
  // mode we first switch to the alternate screen buffer so the entire viewport
  // (bounded transcript + pinned controls) is owned by Ink and nothing written
  // around it can scroll the frame.
  process.stdout.write((fullscreen ? ALT_SCREEN_ENTER : "") + SCREEN_CLEAR);

  // Belt-and-suspenders cleanup: tmux can re-enable modifyOtherKeys when it
  // forwards keyboard mode changes, and Ink's unmount path doesn't touch this
  // mode (it manages kitty + alternate-screen but not XTMODKEYS). Re-disable
  // on every exit path so the terminal isn't left generating CSI 27 sequences
  // that confuse the parent shell.
  const onProcessExit = (): void => {
    try {
      // Leave the alternate screen LAST so the user's original shell scrollback
      // returns intact, with no leftover artifacts from the fullscreen viewport.
      process.stdout.write(
        DISABLE_MODIFY_OTHER_KEYS + DISABLE_FOCUS_REPORTING + (fullscreen ? ALT_SCREEN_LEAVE : ""),
      );
    } catch {
      // stdout may already be torn down; nothing useful to do here.
    }
  };
  process.on("exit", onProcessExit);

  // Safety net: when the TUI is frozen (e.g. the stream hung and abort didn't
  // work), the user must still be able to get out. Ink's exitOnCtrlC is false
  // so the app can handle graceful abort, but if the app itself is stuck we
  // need a process-level escape hatch.
  let sigintCount = 0;
  let sigintTimer: ReturnType<typeof setTimeout> | null = null;
  const onSigint = (): void => {
    sigintCount++;
    if (sigintTimer) clearTimeout(sigintTimer);
    sigintTimer = setTimeout(() => {
      sigintCount = 0;
    }, 2000);
    if (sigintCount === 1) {
      // First Ctrl+C: try to gracefully exit by unmounting Ink
      try {
        ref.instance?.unmount();
      } catch {
        // ignored
      }
      setTimeout(() => process.exit(130), 250);
    } else {
      // Second Ctrl+C: force exit immediately (130 = 128 + SIGINT)
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  // Runtime state lives in this closure so unmount/remount doesn't lose
  // the user's runtime model/provider/thinking choices.
  const runtimeState: RuntimeState = {
    model: config.model,
    provider: config.provider,
    thinking: config.thinking,
  };

  const onRuntimeStateChange = (updates: Partial<RuntimeState>): void => {
    Object.assign(runtimeState, updates);
    config.onRuntimeStateChange?.(updates);
  };

  // Session state — App mirrors its React state here via useEffects, so
  // remounts (overlay close, plan reject) can re-seed from the snapshot
  // without losing the conversation.
  const sessionStore: SessionStore = {
    messages: config.messages,
    history: config.initialHistory ?? [{ kind: "banner", id: "banner" }],
    turnMetrics: config.initialTurnMetrics ?? [],
    liveItems: [],
    doneStatus: null,
    approvedPlanPath: undefined,
    planSteps: [],
    sessionPath: config.sessionPath,
    sessionId: config.sessionId,
    overlay: null,
    planAutoExpand: false,
    pendingAction: undefined,
    planMode: config.planModeRef?.current ?? false,
    idealReviewEnabled: config.idealReviewEnabled ?? true,
  };

  const terminalHistoryPrinter = createTerminalHistoryPrinter();
  const inkOptions = fullscreen ? FULLSCREEN_INK_OPTIONS : INK_OPTIONS;
  const ref: { instance: PatchedInkInstance | null } = { instance: null };

  // Stable closure passed down to App → useTranscriptHistory. Reads ref.instance
  // at call time so it follows resetUI remounts.
  //
  // Pre-mount buffering: Ink's legacy sync mode flushes passive effects DURING
  // render(), so the very first transcript print (the banner) arrives while
  // ref.instance is still null. Writing it raw at that point would land BELOW
  // the already-painted controls frame and strand the frame at the top of the
  // screen. Buffer those bytes and flush them through insertBeforeFrame right
  // after the instance is assigned, so they're folded atomically above the
  // frame like every later flush.
  let preMountHistoryBytes = "";
  const enqueueHistoryWrite = (data: string): void => {
    const instance = ref.instance;
    if (!instance) {
      preMountHistoryBytes += data;
      return;
    }
    if (instance.insertBeforeFrame) {
      instance.insertBeforeFrame(data);
    } else {
      // Unpatched Ink — degrade to the old two-write behavior.
      process.stdout.write(data);
    }
  };
  const flushPreMountHistory = (): void => {
    if (!preMountHistoryBytes) return;
    const data = preMountHistoryBytes;
    preMountHistoryBytes = "";
    enqueueHistoryWrite(data);
  };

  // The bottom anchor must only pad shrinks while the agent is RUNNING (tool
  // panel, status swaps, finalization). At idle, frame shrink is symmetric UI
  // — the slash menu or expanded input closing — and the footer returning up
  // is the correct behavior; padding it leaves permanent whitespace. App
  // mirrors agentLoop.isRunning here. Tracked in the closure so resetUI
  // remounts re-apply the current state to the fresh instance.
  let frameAnchorActive = false;
  const setFrameAnchorActive = (active: boolean): void => {
    frameAnchorActive = active;
    ref.instance?.setFrameAnchorActive?.(active);
  };

  // Bottom-pinned idle shrink backfill (patched ink `frameShrinkBackfill`).
  // When the slash menu (or any idle growth) scrolled the screen and then
  // closes, the scroll cannot be undone — rising would strand dead rows below
  // the footer. Instead ink asks for the last N hard-wrapped transcript rows
  // and paints them into the vacated space, restoring the pre-menu screen
  // exactly. Serializes from sessionStore.history with a throwaway printer
  // (force: dedup state must not be touched); called rarely (menu close).
  //
  // DISABLED BY DEFAULT. This repaint reconstructs the physical screen by
  // RE-SERIALIZING history (markdown re-render + wrapAnsi). When a row's visual
  // width diverges between that reconstruction and the terminal — wide emoji
  // (✅), bold/italic markdown, CJK — the rebuilt row count disagrees with
  // ink's `needRows`/`linesAboveFrame` math, so the `eraseDown + backfillText`
  // repaint OVERLAPS still-present rows (duplicate lines) or pads short with
  // blank rows (injected whitespace). It fires on nearly every turn. Without a
  // provider installed, ink falls back to a cursor-up pad-consume that never
  // repaints content — eliminating both failure modes. Opt back in (to debug or
  // revisit) with GG_SHRINK_BACKFILL=1.
  const shrinkBackfillEnabled = process.env.GG_SHRINK_BACKFILL === "1";
  const buildShrinkBackfill = (needRows: number): string | undefined => {
    const history = sessionStore.history;
    if (needRows <= 0 || !history || history.length === 0) return undefined;
    log("INFO", "scrollback", "shrink-backfill invoked", {
      needRows,
      historyItems: history.length,
    });
    // Inline images can't be faithfully reconstructed by this text-only repaint:
    // a graphics escape carries its base64 payload with zero newlines but many
    // visual rows, so wrapAnsi hard-wraps the payload into literal base64 text
    // and the rebuilt row count never matches the screen. Bailing here makes ink
    // fall back to its non-erasing cursor-up pad consume, which reclaims the gap
    // WITHOUT an eraseDown repaint — leaving the already-drawn image untouched on
    // screen instead of wiping it or shoving the transcript out of alignment.
    if (history.some(itemHasImagePreviews)) {
      log("INFO", "scrollback", "shrink-backfill bail", { reason: "image-previews" });
      return undefined;
    }
    let collected = "";
    try {
      createTerminalHistoryPrinter().print(
        history,
        {
          theme: loadTheme(currentThemeName),
          columns: Math.max(40, process.stdout.columns ?? 80),
          version: config.version,
          model: runtimeState.model,
          provider: runtimeState.provider,
          cwd: config.cwd,
        },
        {
          force: true,
          reason: "shrink-backfill",
          write: (data: string) => {
            collected += data;
          },
        },
      );
    } catch {
      return undefined;
    }
    if (!collected) return undefined;
    const columnsNow = Math.max(40, process.stdout.columns ?? 80);
    const wrapped = wrapAnsi(collected.replace(/\n$/, ""), columnsNow, { trim: false, hard: true });
    const allRows = wrapped.split("\n");
    const lines = allRows.slice(-needRows);
    // Transcript shorter than the vacated space: blank-fill the top so the
    // row count still matches and the footer stays put. Each blank line here
    // is a row of on-screen whitespace injected above the transcript tail —
    // logging blankPad surfaces the "random whitespace" symptom directly.
    const tailRows = lines.length;
    let blankPad = 0;
    while (lines.length < needRows) {
      lines.unshift("");
      blankPad++;
    }
    log("INFO", "scrollback", "shrink-backfill built", {
      needRows,
      reconstructedRows: allRows.length,
      tailRows,
      blankPad,
      columns: columnsNow,
    });
    return `${lines.join("\n")}\n`;
  };

  const buildElement = (): React.ReactElement =>
    React.createElement(
      ThemeProvider,
      {
        initial: currentThemeName,
        onThemeChange: (name: ThemeName) => {
          currentThemeName = name;
        },
      },
      React.createElement(
        TerminalSizeProvider,
        { isAgentRunning: () => !!sessionStore.isAgentRunning, fullscreen },
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
            projectId: config.projectId,
            cwd: config.cwd,
            version: config.version,
            showTokenUsage: config.showTokenUsage,
            idealReviewEnabled: sessionStore.idealReviewEnabled,
            onSlashCommand: config.onSlashCommand,
            loggedInProviders: config.loggedInProviders,
            credentialsByProvider: config.credentialsByProvider,
            initialHistory: sessionStore.history,
            sessionsDir: config.sessionsDir,
            sessionPath: sessionStore.sessionPath,
            sessionId: sessionStore.sessionId,
            processManager: config.processManager,
            subAgentManager: config.subAgentManager,
            lspManager: config.lspManager,
            reviewCoverageTracker: config.reviewCoverageTracker,
            settingsFile: config.settingsFile,
            mcpManager: config.mcpManager,
            authStorage: config.authStorage,
            planModeRef: config.planModeRef,
            skills: config.skills,
            checkpointStore: config.checkpointStore,
            rebuildReadTool: config.rebuildReadTool,
            connectInitialMcpTools: config.connectInitialMcpTools,
            planCallbacks: config.planCallbacks,
            terminalHistoryPrinter,
            enqueueHistoryWrite,
            setFrameAnchorActive,
            fullscreen,
            resetUI,
            onRuntimeStateChange,
            sessionStore,
          }),
        ),
      ),
    );

  // Nuke-and-rebuild paths tear down the React tree and render a fresh Ink
  // instance. Non-wipe remounts clear only the live viewport while preserving
  // real terminal scrollback; fresh sessions clear screen + scrollback intentionally.
  function resetUI(options?: ResetUIOptions): void {
    const old = ref.instance;
    if (!old) return;
    log("INFO", "scrollback", "resetUI", {
      wipeSession: String(Boolean(options?.wipeSession)),
      resizeRedraw: String(Boolean(options?.resizeRedraw)),
      historyOverride: String(options?.history !== undefined),
      messagesOverride: String(options?.messages !== undefined),
      pendingAction: String(Boolean(options?.pendingAction)),
      sessionHistoryItems: sessionStore.history.length,
      clearMode: getResetClearMode(options),
      fullscreen: String(fullscreen),
    });

    if (options?.wipeSession) {
      // Wipe everything session-scoped FIRST. Other options below can then
      // re-seed specific fields (e.g. plan accept wipes the chat then sets
      // approvedPlanPath + planSteps for the implementation phase).
      terminalHistoryPrinter.clear();
      sessionStore.history = [{ kind: "banner", id: "banner" }];
      sessionStore.turnMetrics = [];
      sessionStore.liveItems = [];
      sessionStore.doneStatus = null;
      sessionStore.approvedPlanPath = undefined;
      sessionStore.planSteps = [];
    }
    if (options?.messages) sessionStore.messages = options.messages;
    if (options?.history) {
      terminalHistoryPrinter.clear();
      sessionStore.history = options.history;
    }
    if (options?.approvedPlanPath !== undefined) {
      sessionStore.approvedPlanPath = options.approvedPlanPath;
    }
    if (options?.planSteps !== undefined) sessionStore.planSteps = options.planSteps;
    if (options?.sessionPath !== undefined) sessionStore.sessionPath = options.sessionPath;
    if (options?.sessionPath !== undefined && !sessionStore.sessionId) {
      sessionStore.sessionId = config.sessionId;
    }
    if (options?.pendingAction) sessionStore.pendingAction = options.pendingAction;

    old.unmount();
    // Null the ref so any history flush fired during the new instance's
    // synchronous mount is buffered by enqueueHistoryWrite (the unmounted old
    // instance's insertBeforeFrame silently drops bytes). Safe for the
    // waitUntilExit loop: this function runs synchronously, so by the time the
    // loop's await continuation executes, ref.instance is the new instance.
    ref.instance = null;
    if (options?.resizeRedraw) {
      terminalHistoryPrinter.resetPrinted();
    }
    // Fullscreen alt-screen mode owns the entire screen and renders the
    // transcript inside Ink, so there is no native scrollback to preserve or
    // repaint — "clear" is just a screen wipe + cursor home before re-render.
    if (fullscreen) {
      process.stdout.write(VIEWPORT_CLEAR);
      ref.instance = render(buildElement(), inkOptions);
      ref.instance.setFrameAnchorActive?.(frameAnchorActive);
      if (shrinkBackfillEnabled) ref.instance.setFrameShrinkBackfill?.(buildShrinkBackfill);
      flushPreMountHistory();
      return;
    }
    // Resize can leave log-update frames at the old width in the visible viewport.
    // Repaint the durable transcript after a full clear so messages don't appear
    // to vanish on maximize and old input/status frames don't stack as duplicates.
    // Other non-wipe remounts keep scrollback and only clear the live viewport.
    process.stdout.write(getResetClearMode(options) === "screen" ? SCREEN_CLEAR : VIEWPORT_CLEAR);
    if (options?.resizeRedraw && sessionStore.history.length > 0) {
      terminalHistoryPrinter.print(
        sessionStore.history,
        {
          theme: loadTheme(currentThemeName),
          columns: Math.max(40, process.stdout.columns ?? 80),
          version: config.version,
          model: runtimeState.model,
          provider: runtimeState.provider,
          cwd: config.cwd,
        },
        { reason: "resize-redraw" },
      );
    }
    ref.instance = render(buildElement(), inkOptions);
    ref.instance.setFrameAnchorActive?.(frameAnchorActive);
    if (shrinkBackfillEnabled) ref.instance.setFrameShrinkBackfill?.(buildShrinkBackfill);
    flushPreMountHistory();
  }

  ref.instance = render(buildElement(), inkOptions);
  ref.instance.setFrameAnchorActive?.(frameAnchorActive);
  if (shrinkBackfillEnabled) ref.instance.setFrameShrinkBackfill?.(buildShrinkBackfill);
  flushPreMountHistory();

  // Terminal resize → full unmount/remount. Completed transcript rows are real
  // terminal output now, so resetUI() only rebuilds the live Ink controls unless
  // a fresh-session path asked to wipe scrollback. Debounced 250ms (shorter than
  // the hook's 300ms) so resetUI wins the race; the hook's pending timer is
  // cancelled by its own useEffect cleanup when the old instance unmounts.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const onTerminalResize = (): void => {
    // Fullscreen alt-screen mode owns a full-height frame that Ink repaints in
    // place on dimension changes (handled inside TerminalSizeProvider). No
    // unmount/remount is needed — and doing one would flash the whole screen.
    if (fullscreen) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      // While the agent is running, the full unmount/remount would fire
      // useAgentLoop's cleanup and abort the in-flight request — so the
      // agent dies on maximize. Skip the unmount in that case. Flag
      // pendingResetUI so App.tsx fires a deferred resetUI the moment the
      // agent goes idle, fixing any live-area drift that accumulated.
      log("INFO", "scrollback", "resize fired", {
        agentRunning: String(Boolean(sessionStore.isAgentRunning)),
        columns: process.stdout.columns ?? 0,
        rows: process.stdout.rows ?? 0,
      });
      if (sessionStore.isAgentRunning) {
        sessionStore.pendingResetUI = true;
        return;
      }
      resetUI({ resizeRedraw: true });
    }, 250);
  };
  process.stdout.on("resize", onTerminalResize);

  // Loop: when /clear remounts, the OLD instance's waitUntilExit resolves
  // (because unmount() resolves it). We then need to wait on the NEW
  // instance. If exit was final (no replacement), ref.instance is nulled
  // by unmount and the loop ends.
  try {
    while (true) {
      const current: PatchedInkInstance | null = ref.instance;
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
    process.off("exit", onProcessExit);
    process.off("SIGINT", onSigint);
    if (sigintTimer) clearTimeout(sigintTimer);
    // Final cleanup on normal exit — also covered by the "exit" handler,
    // but writing here ensures the disable lands before Node tears stdout
    // down on process termination.
    try {
      process.stdout.write(
        DISABLE_MODIFY_OTHER_KEYS + DISABLE_FOCUS_REPORTING + (fullscreen ? ALT_SCREEN_LEAVE : ""),
      );
    } catch {
      // ignored
    }
  }
}
