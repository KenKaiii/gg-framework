import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { ThemeContext, loadTheme, useTheme } from "@kenkaiiii/ggcoder/ui/theme";
import { AnimationProvider } from "@kenkaiiii/ggcoder/ui";
import { useDoublePress } from "@kenkaiiii/ggcoder/ui/hooks/double-press";
import type { Provider } from "@kenkaiiii/gg-ai";
import { getNextThinkingLevel } from "@kenkaiiii/gg-core";
import { TerminalSizeProvider, useTerminalSize } from "@kenkaiiii/ggcoder/ui/hooks/terminal-size";
import { BossChatScreen } from "./boss-chat-screen.js";
import { bossStore, getBossState, useBossState } from "./boss-store.js";
import type { BossOverlay } from "./boss-store.js";
import { BOSS_SLASH_COMMANDS, canonicalName, parseSlash, buildHelpText } from "./slash-commands.js";
import { projectColor } from "./colors.js";
import { COLORS } from "./branding.js";
import type { GGBoss } from "./orchestrator.js";
import { VERSION } from "./branding.js";
import { BossStreamingTurnView } from "./boss-transcript-rows.js";
import { createBossTerminalHistoryPrinter } from "./boss-terminal-history.js";
import type { BossDisplayItem } from "./boss-ui-items.js";
import { getCurrentStation, playRadio, stopRadio, RADIO_STATIONS } from "./radio.js";
import {
  getPendingUpdate,
  startPeriodicUpdateCheck,
  stopPeriodicUpdateCheck,
} from "./auto-update.js";

interface BossAppProps {
  boss: GGBoss;
  terminalHistoryPrinter?: ReturnType<typeof createBossTerminalHistoryPrinter>;
  /**
   * Called from /clear. Wired in `renderBossApp` to ANSI-wipe the terminal,
   * unmount the current Ink instance, and render a fresh one — the only
   * reliable way to reset log-update's internal cursor/line-count tracking
   * without the drift that manifests as "input pushed upward" after /clear.
   */
  resetUI?: (reason?: BossResetUiReason) => void;
}

export function BossApp(props: BossAppProps): React.ReactElement {
  const theme = loadTheme("dark");
  return (
    <TerminalSizeProvider>
      <ThemeContext.Provider value={theme}>
        <AnimationProvider>
          <BossAppInner {...props} />
        </AnimationProvider>
      </ThemeContext.Provider>
    </TerminalSizeProvider>
  );
}

function BossAppInner({ boss, resetUI, terminalHistoryPrinter }: BossAppProps): React.ReactElement {
  const state = useBossState();
  const theme = useTheme();
  const { exit } = useApp();
  const { stdout, write: writeStdout } = useStdout();
  const { columns, rows } = useTerminalSize();
  const runStartRef = useRef<number | null>(null);
  runStartRef.current = state.runStartMs;
  // Live char count of the current streaming text — drives ActivityIndicator's
  // smooth token-counter animation between turn_end events.
  const charCountRef = useRef<number>(0);
  charCountRef.current = state.streaming?.text.length ?? 0;
  // Accumulated real input tokens across completed turns — used alongside
  // charCountRef so the counter interpolates smoothly between hard updates.
  const realTokensAccumRef = useRef<number>(0);
  realTokensAccumRef.current = state.bossInputTokens;
  // Track the most recent user message so the activity bar's contextual phrase
  // selection has something to riff on (when not using BOSS_PHRASES override).
  const [lastUserMessage, setLastUserMessage] = useState<string>("");
  // Overlay state lives in bossStore so it survives the unmount/remount
  // performed by openOverlay/closeOverlay. The new mount reads this back
  // and renders the same overlay it had pre-remount. See the resetUI
  // comment in renderBossApp for why we remount instead of just toggling
  // React state.
  const overlay = state.overlay;
  // Track the currently-playing station id so the picker can mark it with *
  // and so we have a reactive value for any future "now playing" indicator.
  // Seeded from the radio module's module-level state — usually null on
  // launch but resilient to a hot-restart of the React tree.
  const [currentRadio, setCurrentRadio] = useState<string | null>(() => getCurrentStation());
  // Auto-update indicator: true when a newer version of @kenkaiiii/gg-boss
  // is on disk waiting for the next restart. Seeded synchronously from the
  // state file (so we show the indicator immediately if a previous session
  // queued one) and bumped to true by the periodic check below if a fresh
  // version drops mid-session.
  const [updatePending, setUpdatePending] = useState<boolean>(
    () => getPendingUpdate(VERSION) !== null,
  );

  // Periodic in-session check — pings npm every hour while the session is
  // alive. If a newer version arrives, we set updatePending so the worker
  // bar shows the "✨ Update ready · restart to apply" hint, AND drop a
  // friendly info row into chat so the user sees the news immediately.
  useEffect(() => {
    startPeriodicUpdateCheck(VERSION, (msg) => {
      // Dedicated update_notice item so the renderer wraps it in a
      // rounded success-bordered ✨ box. Plain info rows render flat and
      // disappear into worker chatter.
      bossStore.appendUpdateNotice(msg);
      setUpdatePending(true);
    });
    return () => stopPeriodicUpdateCheck();
  }, []);

  // Terminal title — dynamically reflects worker activity so the user can
  // glance at the tab/window from another app and see how many workers are
  // still running. OSC 0 sets both window and tab title in most modern
  // terminals (Ghostty, Terminal.app, iTerm2, Kitty).
  //
  // States:
  //   N workers running    "● 5 workers running · GG Boss"
  //   1 worker running     "● 1 worker running · GG Boss"
  //   boss thinking only   "● GG Boss"
  //   idle                 "GG Boss"
  const workersRunning = state.workers.filter((w) => w.status === "working").length;
  const titlePrevRef = useRef("");
  useEffect(() => {
    if (!stdout) return;
    let title: string;
    if (workersRunning > 0) {
      const label = `${workersRunning} worker${workersRunning === 1 ? "" : "s"} running`;
      title = `● ${label} · GG Boss`;
    } else if (state.phase === "working") {
      title = "● GG Boss";
    } else {
      title = "GG Boss";
    }
    if (title !== titlePrevRef.current) {
      titlePrevRef.current = title;
      stdout.write(`\x1b]0;${title}\x1b\\`);
    }
  }, [stdout, workersRunning, state.phase]);
  useEffect(() => {
    return () => {
      stdout?.write(`\x1b]0;GG Boss\x1b\\`);
    };
  }, [stdout]);

  const liveItems = state.liveItems;
  const terminalHistoryPrinterRef = useRef(
    terminalHistoryPrinter ?? createBossTerminalHistoryPrinter({ stream: stdout }),
  );
  const terminalHistoryContext = {
    theme,
    columns,
    version: VERSION,
    model: state.bossModel,
    provider: state.bossProvider,
    cwd: process.cwd(),
  };
  const printedHistoryIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const printer = terminalHistoryPrinterRef.current;
    const pending = state.history.filter((item) => !printedHistoryIdsRef.current.has(item.id));
    if (pending.length === 0) return;
    printer.print(pending, terminalHistoryContext, { write: writeStdout });
    for (const item of pending) printedHistoryIdsRef.current.add(item.id);
  }, [columns, state.bossModel, state.bossProvider, state.history, theme, writeStdout]);

  /**
   * Opening or closing an overlay shrinks/grows the live area dramatically
   * (tasks pane → chat chrome, model picker → chat chrome, etc.). Toggling
   * React state alone leaves Ink's log-update cursor math drifting on the
   * very next streaming response, surfacing as "input pushed upward, new
   * chat lines disappear off the top". Mirrors ggcoder's broader fix
   * (commit 0246c6d): every overlay open/close goes through resetUI which
   * unmounts the Ink instance and renders a fresh one. The overlay
   * selection survives via bossStore.overlay.
   */
  const overlayResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (overlayResetTimerRef.current) clearTimeout(overlayResetTimerRef.current);
    };
  }, []);

  const scheduleOverlayReset = useCallback((): void => {
    if (!resetUI) return;
    if (overlayResetTimerRef.current) clearTimeout(overlayResetTimerRef.current);
    overlayResetTimerRef.current = setTimeout(() => {
      overlayResetTimerRef.current = null;
      resetUI();
    }, 0);
  }, [resetUI]);

  const openOverlay = useCallback(
    (next: BossOverlay): void => {
      bossStore.setOverlay(next);
      scheduleOverlayReset();
    },
    [scheduleOverlayReset],
  );

  const closeOverlay = useCallback((): void => {
    bossStore.setOverlay(null);
    scheduleOverlayReset();
  }, [scheduleOverlayReset]);
  void stdout;

  // ggcoder's double-press pattern: 800ms window. First press shows
  // "Press Ctrl+C again to exit" in the footer; second within 800ms exits.
  const handleDoubleExit = useDoublePress(
    (pending) => bossStore.setExitPending(pending),
    () => exit(),
  );

  useEffect(() => {
    if (state.pendingFlush.length > 0) {
      bossStore.commitPendingFlush();
    }
  }, [state.flushGeneration, state.pendingFlush.length]);

  const handleAbort = useCallback((): void => {
    // Ctrl+C while boss is running → single-press abort (matches ggcoder).
    if (state.phase === "working") {
      boss.abort();
      return;
    }
    // Boss is idle → double-press to exit, with footer pending message.
    handleDoubleExit();
  }, [boss, handleDoubleExit, state.phase]);

  // ── App-level keyboard ──────────────────────────────────
  // Ctrl+T toggles the Tasks overlay globally. Ctrl+C is handled here only
  // while an overlay owns focus; in the chat view the shared gg-coder InputArea
  // owns Ctrl+C/ESC, so a single press cannot hit two abort/exit handlers.
  useInput((input, key) => {
    if (key.ctrl && input === "c" && overlay) {
      handleAbort();
      return;
    }
    if (key.ctrl && input === "t") {
      if (overlay === "tasks") closeOverlay();
      else openOverlay("tasks");
      return;
    }
  });

  const handleSlashCommand = async (value: string): Promise<boolean> => {
    const parsed = parseSlash(value);
    if (!parsed) return false;
    const name = canonicalName(parsed.name);
    if (!name) {
      bossStore.appendInfo(`Unknown command: /${parsed.name}`, "warning");
      return true;
    }
    switch (name) {
      case "help":
        bossStore.appendUser(value);
        // Render help via an assistant block so Markdown formatting + dot prefix.
        bossStore.appendInfo(buildHelpText(), "info");
        return true;
      case "clear":
        // Order matters. resetUI() unmounts the old Ink instance and
        // synchronously renders a fresh one — that first render reads the
        // bossStore via useBossState(). If we clear the store AFTER resetUI,
        // the new <Static> emits every old history item into the just-wiped
        // scrollback, which is exactly the "input pushed upward, subsequent
        // messages look cleared" symptom. Empty the store first so the new
        // instance mounts against an empty history.
        bossStore.clearHistory();
        resetUI?.("session-clear");
        await boss.resetConversation();
        bossStore.appendInfo("Session cleared.", "info");
        return true;
      case "model-boss":
        openOverlay("model-boss");
        return true;
      case "model-workers":
        openOverlay("model-workers");
        return true;
      case "compact":
        bossStore.appendUser(value);
        await boss.manualCompact();
        return true;
      case "radio":
        openOverlay("radio");
        return true;
      case "quit":
        exit();
        return true;
    }
    return false;
  };

  const handleModelSelect = (value: string): void => {
    const colon = value.indexOf(":");
    if (colon < 0) {
      closeOverlay();
      return;
    }
    const provider = value.slice(0, colon) as Provider;
    const model = value.slice(colon + 1);
    const switchPromise =
      overlay === "model-boss"
        ? boss.switchBossModel(provider, model)
        : overlay === "model-workers"
          ? boss.switchWorkerModel(provider, model)
          : Promise.resolve();
    void switchPromise.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      bossStore.appendInfo(`Model switch failed: ${message}`, "error");
    });
    closeOverlay();
  };

  const handleSubmit = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
      void handleSlashCommand(trimmed);
      return;
    }
    const userItem = bossStore.createUserItem(trimmed);
    terminalHistoryPrinterRef.current.print([userItem], terminalHistoryContext, {
      write: writeStdout,
    });
    printedHistoryIdsRef.current.add(userItem.id);
    bossStore.queueSubmittedUserItem(userItem);
    setLastUserMessage(trimmed);
    // Inject the scope pill into the message the boss actually sees, so the
    // user doesn't have to write "for the yaatuber project, …" every prompt.
    const scoped = scopePrefix(state.scope) + trimmed;
    boss.enqueueUserMessage(scoped);
  };

  const activityVisible = state.phase === "working" && state.activityPhase !== "idle";
  const stallStatusVisible = false;
  const doneStatus = null;
  const statusSlotVisible = activityVisible || stallStatusVisible || !!doneStatus;
  const controlsRows = 7 + (statusSlotVisible ? 1 : 0) + (state.exitPending ? 0 : 1);
  const availableLiveRows = Math.max(1, rows - controlsRows);

  // Live area = streaming + activity + input (≥3 lines, bordered) + footer +
  // workerbar. Below ~14 rows we can't fit all of it without log-update
  // running out of vertical space — at which point Ink's cursor math drifts
  // and you see "input pushed upward, new output disappears." Render a
  // friendly resize hint instead so the user knows what's happening rather
  // than thinking the app is broken. We're already past the static history
  // mount, so scrollback survives the resize that brings the user back.
  if (rows < 14) {
    return (
      <Box flexDirection="column" width={columns} paddingX={1} marginTop={1}>
        <Text bold color={COLORS.accent}>
          {"Terminal too small"}
        </Text>
        <Text color={COLORS.primary}>
          {`Resize to at least 14 rows to use GG Boss (currently ${rows}).`}
        </Text>
      </Box>
    );
  }

  const lastPendingHistoryItem = state.pendingFlush[state.pendingFlush.length - 1] as
    | BossDisplayItem
    | undefined;
  const lastHistoryItem = state.history[state.history.length - 1] as BossDisplayItem | undefined;
  const livePane = (
    <BossStreamingTurnView
      turn={state.streaming}
      isRunning={state.phase === "working"}
      liveItems={liveItems}
      lastPendingHistoryItem={lastPendingHistoryItem}
      lastHistoryItem={lastHistoryItem}
      availableTerminalHeight={availableLiveRows}
    />
  );

  return (
    <BossChatScreen
      boss={boss}
      columns={columns}
      state={state}
      overlay={overlay}
      livePane={livePane}
      theme={theme}
      statusSlotVisible={statusSlotVisible}
      activityVisible={activityVisible}
      stallStatusVisible={stallStatusVisible}
      doneStatus={doneStatus}
      elapsedMs={state.runStartMs ? Date.now() - state.runStartMs : 0}
      runStartRef={runStartRef as React.RefObject<number>}
      charCountRef={charCountRef}
      realTokensAccumRef={realTokensAccumRef}
      lastUserMessage={lastUserMessage}
      activeToolNames={(state.streaming?.tools ?? [])
        .filter((tool) => tool.status === "running")
        .map((tool) => tool.name)}
      inputActive={!overlay}
      isRunning={state.phase === "working"}
      onSubmit={handleSubmit}
      onAbort={handleAbort}
      onTab={() => bossStore.cycleScope()}
      onShiftTab={() => {
        const next = getNextThinkingLevel(
          state.bossProvider,
          state.bossModel,
          state.bossThinkingLevel,
        );
        void boss.setBossThinking(next);
      }}
      commands={BOSS_SLASH_COMMANDS}
      scopeBadge={<ScopePill scope={state.scope} />}
      onCloseOverlay={closeOverlay}
      onModelSelect={handleModelSelect}
      currentRadio={currentRadio}
      onRadioSelect={(value) => {
        if (value === "off") {
          stopRadio();
          setCurrentRadio(null);
          bossStore.appendInfo("Radio off.", "info");
        } else {
          const result = playRadio(value);
          if (result.ok) {
            setCurrentRadio(value);
            const station = RADIO_STATIONS.find((stationInfo) => stationInfo.id === value);
            bossStore.appendInfo(`Now playing: ${station?.name ?? value}`, "info");
          } else {
            bossStore.appendInfo(result.error ?? "Radio failed to start.", "warning");
          }
        }
        closeOverlay();
      }}
      bossModel={state.bossModel}
      workerModel={state.workerModel}
      updatePending={updatePending}
      currentRadioStationId={currentRadio}
      radioStations={RADIO_STATIONS}
      workers={state.workers}
      pendingMessages={state.pendingUserMessages}
      formatDuration={formatBossDuration}
    />
  );
}

// ── Scope pill (gg-boss specific) ──────────────────────────

function ScopePill({ scope }: { scope: string }): React.ReactElement {
  const theme = useTheme();
  const isAll = scope === "all";
  // "All" → boss accent (fuchsia) so multi-project mode wears the brand.
  // Specific project → its stable project color so the pill matches its
  // appearances elsewhere in the TUI.
  const bg = isAll ? COLORS.accent : projectColor(scope);
  const label = isAll ? "All" : scope;
  // Black text reads cleanly on every color in the palette — the project hues
  // are deliberately light/saturated, which is unreadable with white on top.
  return (
    <Text>
      <Text color={theme.textDim}>Project </Text>
      <Text color="black" backgroundColor={bg} bold>
        {` ${label} `}
      </Text>
      <Text color={theme.textDim}>
        {"  "}
        <Text color={theme.primary}>Tab</Text>
        {" to switch"}
      </Text>
    </Text>
  );
}

/**
 * Prepend the active scope to the user's message before it reaches the boss.
 * Boss's system prompt teaches it to interpret these prefixes.
 */
function scopePrefix(scope: string): string {
  if (scope === "all") return "[scope:all] ";
  return `[scope:${scope}] `;
}

function formatBossDuration(durationMs: number): string {
  const total = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// ── Renderer ───────────────────────────────────────────────

export interface RenderBossAppOptions {
  boss: GGBoss;
}

const INK_OPTIONS = {
  // Match ggcoder's keyboard setup: enable kitty keyboard so Ink can decode
  // enhanced key events, but keep exitOnCtrlC false so our handlers receive it.
  kittyKeyboard: {
    mode: "enabled" as const,
    flags: ["disambiguateEscapeCodes" as const],
  },
  exitOnCtrlC: false,
};

// Match ggcoder's terminal keyboard hygiene. Some terminals/tmux sessions leave
// xterm modifyOtherKeys enabled, which makes ordinary keys arrive as CSI 27
// escape sequences that Ink/InputArea won't treat as text.
const DISABLE_MODIFY_OTHER_KEYS = "\x1b[>4;0m";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const SCREEN_CLEAR = DISABLE_MODIFY_OTHER_KEYS + "\x1b[2J\x1b[3J\x1b[H";
const VIEWPORT_CLEAR = DISABLE_MODIFY_OTHER_KEYS + "\x1b[2J\x1b[H";

type BossResetUiReason = "viewport" | "resize-redraw" | "session-clear";

export function renderBossApp(opts: RenderBossAppOptions): {
  waitUntilExit: () => Promise<void>;
  unmount: () => void;
} {
  const terminalHistoryPrinter = createBossTerminalHistoryPrinter({ stream: process.stdout });
  process.stdout.write(SCREEN_CLEAR);
  const onProcessExit = (): void => {
    try {
      process.stdout.write(DISABLE_MODIFY_OTHER_KEYS + DISABLE_FOCUS_REPORTING);
    } catch {
      // stdout may already be torn down.
    }
  };
  process.on("exit", onProcessExit);

  // Nuke-and-rebuild approach for /clear. Three earlier attempts at patching
  // Ink's internal frame-tracking state in place all hit the same wall: even
  // with log-update reset + lastOutput cleared + fullStaticOutput dropped,
  // the live area drifts after the next streaming response because Ink's
  // cursor math depends on terminal-state assumptions that ANSI clearing
  // breaks. The only RELIABLE reset is to teardown the React tree entirely
  // and render a fresh Ink instance. State outside React (GGBoss class,
  // bossStore singleton) survives and the new tree picks it up correctly.
  const ref: { instance: ReturnType<typeof render> | null } = { instance: null };
  const resetUI = (reason: BossResetUiReason = "viewport"): void => {
    const old = ref.instance;
    if (!old) return;
    // Unmount unsubscribes Ink's stdin handlers + tears down the React tree.
    old.unmount();

    if (reason === "resize-redraw") {
      // A resize malformed the visible frame at the old width. Match gg-coder:
      // full screen clear, reset terminal-history dedupe, then repaint the
      // durable transcript once before mounting fresh live controls.
      terminalHistoryPrinter.resetPrinted();
      process.stdout.write(SCREEN_CLEAR);
      const snapshot = getBossState();
      if (snapshot.history.length > 0) {
        terminalHistoryPrinter.print(snapshot.history, {
          theme: loadTheme("dark"),
          columns: Math.max(40, process.stdout.columns ?? 80),
          version: VERSION,
          model: snapshot.bossModel,
          provider: snapshot.bossProvider,
          cwd: process.cwd(),
        });
      }
    } else if (reason === "session-clear") {
      // /clear starts a fresh durable transcript. Clear the terminal-history
      // dedupe so the banner seeded in bossStore.history prints on the new mount.
      terminalHistoryPrinter.clear();
      process.stdout.write(SCREEN_CLEAR);
    } else {
      // Overlay remounts preserve real scrollback; just drop stale live frames
      // and reset xterm modifyOtherKeys before Ink re-enables input.
      process.stdout.write(VIEWPORT_CLEAR);
    }

    ref.instance = render(
      <BossApp
        boss={opts.boss}
        resetUI={resetUI}
        terminalHistoryPrinter={terminalHistoryPrinter}
      />,
      INK_OPTIONS,
    );
  };
  // Disable Ink's built-in exit-on-Ctrl+C — we need our own double-press
  // handler in BossApp to drive the "Press Ctrl+C again to exit" footer
  // message. With this flag true (the default), Ink kills the process on
  // the very first Ctrl+C and InputArea's onAbort never runs.
  const instance = render(
    <BossApp boss={opts.boss} resetUI={resetUI} terminalHistoryPrinter={terminalHistoryPrinter} />,
    INK_OPTIONS,
  );
  ref.instance = instance;

  // Terminal resize → full unmount/remount of the Ink instance.
  //
  // useTerminalSize already debounces resize events (300ms) and writes a
  // screen clear at the end of a drag, but that doesn't reset Ink's
  // log-update internal line-count tracking — so on the very next render
  // the live area is positioned against stale cursor state and the input
  // box ends up pinned to the top of the viewport with new chat lines
  // disappearing off-screen. That's the exact symptom /clear hit, and the
  // fix is the same: tear down the React tree and start fresh.
  //
  // Debounce is 250ms — slightly shorter than the hook's 300ms so resetUI
  // wins the race. When resetUI's unmount runs, the hook's pending
  // setTimeout is cleared by its own useEffect cleanup, so we don't
  // double-fire. State outside React (GGBoss class, bossStore singleton,
  // overlay) survives.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeListenerEnabled = false;
  const enableResizeListener = setTimeout(() => {
    resizeListenerEnabled = true;
  }, 1000);
  const onTerminalResize = (): void => {
    if (!resizeListenerEnabled) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (getBossState().phase === "working") return;
      resetUI("resize-redraw");
    }, 250);
  };
  process.stdout.on("resize", onTerminalResize);

  return {
    // Follow ref.instance through restarts: when /clear nukes the current
    // instance and creates a new one, this promise re-binds to whichever
    // Ink instance is alive now. Without the loop, we'd wait on the OLD
    // instance's waitUntilExit (which already resolved on unmount) and
    // exit the CLI immediately after every /clear.
    waitUntilExit: async () => {
      while (true) {
        const current = ref.instance;
        if (!current) {
          process.stdout.off("resize", onTerminalResize);
          process.off("exit", onProcessExit);
          clearTimeout(enableResizeListener);
          if (resizeTimer) clearTimeout(resizeTimer);
          onProcessExit();
          return;
        }
        await current.waitUntilExit();
        // If the user ran /clear, ref.instance is now a NEW instance —
        // loop and wait on that one. If exit was final (no replacement),
        // ref.instance was nulled below and the loop ends.
        if (ref.instance === current) {
          ref.instance = null;
          process.stdout.off("resize", onTerminalResize);
          process.off("exit", onProcessExit);
          clearTimeout(enableResizeListener);
          if (resizeTimer) clearTimeout(resizeTimer);
          onProcessExit();
          return;
        }
      }
    },
    unmount: () => {
      process.stdout.off("resize", onTerminalResize);
      process.off("exit", onProcessExit);
      clearTimeout(enableResizeListener);
      if (resizeTimer) clearTimeout(resizeTimer);
      onProcessExit();
      ref.instance?.unmount();
    },
  };
}
