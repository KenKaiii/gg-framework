import React, { useState, useRef, useEffect, useMemo } from "react";
import { Text, Box, useInput, useStdin, useIsScreenReaderEnabled } from "ink";
import type { EventEmitter } from "events";
import { useTheme } from "../theme/theme.js";
import { useFocusedAnimation, deriveFrame } from "./AnimationContext.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import type { ImageAttachment } from "../../utils/image.js";
import { extractImagePaths, readImageFile, getClipboardImage } from "../../utils/image.js";
import { SlashCommandMenu, filterCommands, type SlashCommandInfo } from "./SlashCommandMenu.js";
import { TaskPickerMenu } from "./TaskPickerMenu.js";
import { stripTerminalFocusSequences } from "../utils/terminal-input.js";
import type { TaskRecord } from "../../core/tasks-store.js";
import { log } from "../../core/logger.js";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";

const MAX_VISIBLE_LINES = 12;
const PROMPT = "> ";
const PLACEHOLDER = "  Type your message or / to run a command";
const INPUT_BACKGROUND = "#374151";
const INPUT_TOP_FILL = "▄";
const INPUT_BOTTOM_FILL = "▀";

// SGR mouse sequence: ESC [ < button ; col ; row M/m
// M = press, m = release. Coordinates are 1-based.
// SGR mouse sequence (global) — used both to strip sequences from input data
// and to extract click coordinates. Must reset lastIndex before each use.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_RE_G = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// Enable/disable escape sequences for SGR mouse tracking.
// ?1000h = basic click tracking, ?1006h = SGR extended mode (supports coords > 223).
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";

// Idle window (ms) for the legacy scroll-passthrough release: a short pause
// reliably spans a wheel gesture before tracking re-arms.
const SCROLL_PAUSE_MS = 300;
// Safety net only. In fullscreen, native text selection releases the mouse with
// NO active timer — the wheel re-arms on the next keystroke instead, so a slow
// drag is never cut short. This long timer only fires if the user never presses
// a key afterward (e.g. copies text and switches apps), so the mouse doesn't
// stay captured forever in that edge case.
const NATIVE_INTERACTION_SAFETY_MS = 60_000;

// Guard against stray SGR mouse sequences leaking into text input.
// Some terminals or multiplexers send these even without mouse tracking enabled.
function isMouseEscapeSequence(input: string): boolean {
  return input.includes("[<") && /\[<\d+;\d+;\d+[Mm]/.test(input);
}

// Option+Arrow escape sequences — terminals send these as raw input strings
// rather than setting key.meta + key.leftArrow reliably.
const OPTION_LEFT_SEQUENCES = new Set([
  "\x1bb", // Meta+b (emacs style)
  "\x1b[1;3D", // CSI 1;3 D (xterm with modifiers)
]);
const OPTION_RIGHT_SEQUENCES = new Set([
  "\x1bf", // Meta+f (emacs style)
  "\x1b[1;3C", // CSI 1;3 C (xterm with modifiers)
]);

/** Classify a character as word, punctuation, or space. */
function charClass(ch: string): "word" | "punct" | "space" {
  if (/\s/.test(ch)) return "space";
  if (/\w/.test(ch)) return "word";
  return "punct";
}

/** Find the start of the previous word from `pos` in `text`. */
function prevWordBoundary(text: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;
  // Skip whitespace
  while (i > 0 && charClass(text[i]) === "space") i--;
  if (i <= 0) return 0;
  // Skip through same character class (word or punct)
  const cls = charClass(text[i]);
  while (i > 0 && charClass(text[i - 1]) === cls) i--;
  return i;
}

/** Find the end of the next word from `pos` in `text`. */
function nextWordBoundary(text: string, pos: number): number {
  const len = text.length;
  if (pos >= len) return len;
  let i = pos;
  // Skip through current character class (word or punct)
  const cls = charClass(text[i]);
  while (i < len && charClass(text[i]) === cls) i++;
  // Skip whitespace
  while (i < len && charClass(text[i]) === "space") i++;
  return i;
}

/** Get the normalized selection range [start, end] from anchor and cursor, or null. */
function getSelectionRange(anchor: number | null, cur: number): [number, number] | null {
  if (anchor === null || anchor === cur) return null;
  return [Math.min(anchor, cur), Math.max(anchor, cur)];
}

// ── Kill Ring (module-level, persists across renders) ─────
const KILL_RING_MAX = 10;
const killRing: string[] = [];
let killRingIndex = 0;
let lastActionWasKill = false;
let lastActionWasYank = false;
let lastYankStart = 0;
let lastYankLength = 0;

function pushKill(text: string, direction: "append" | "prepend"): void {
  if (!text) return;
  if (lastActionWasKill && killRing.length > 0) {
    killRing[0] = direction === "append" ? killRing[0] + text : text + killRing[0];
  } else {
    killRing.unshift(text);
    if (killRing.length > KILL_RING_MAX) killRing.pop();
  }
  lastActionWasKill = true;
  lastActionWasYank = false;
}

function yankText(): string {
  return killRing[0] ?? "";
}

function recordYank(start: number, length: number): void {
  lastYankStart = start;
  lastYankLength = length;
  lastActionWasYank = true;
  killRingIndex = 0;
}

function yankPop(): { text: string; start: number; length: number } | null {
  if (!lastActionWasYank || killRing.length <= 1) return null;
  killRingIndex = (killRingIndex + 1) % killRing.length;
  const text = killRing[killRingIndex];
  const result = { text, start: lastYankStart, length: lastYankLength };
  lastYankLength = text.length;
  return result;
}

// ── Persistent Input History ─────────────────────────────
const HISTORY_FILE = join(homedir(), ".gg", "input-history.jsonl");
const MAX_HISTORY = 500;
// Compact when file has 50% more lines than the cap
const COMPACT_THRESHOLD = MAX_HISTORY + Math.floor(MAX_HISTORY * 0.5);
let lineCountEstimate = 0;

function loadHistory(): string[] {
  try {
    const data = readFileSync(HISTORY_FILE, "utf-8");
    const lines = data.trim().split("\n").filter(Boolean);
    lineCountEstimate = lines.length;
    return lines.map((l) => JSON.parse(l) as string).slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function appendHistory(entry: string, history: string[]): void {
  // Skip consecutive duplicates
  if (history.length > 0 && history[history.length - 1] === entry) return;

  try {
    mkdirSync(join(homedir(), ".gg"), { recursive: true });
    appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
    lineCountEstimate++;
    if (lineCountEstimate > COMPACT_THRESHOLD) {
      compactHistory();
    }
  } catch {
    // Silently ignore write failures
  }
}

function compactHistory(): void {
  const tempPath = `${HISTORY_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    const data = readFileSync(HISTORY_FILE, "utf-8");
    const lines = data.trim().split("\n").filter(Boolean);
    const trimmed = lines.slice(-MAX_HISTORY);
    writeFileSync(tempPath, trimmed.map((l) => l + "\n").join(""));
    renameSync(tempPath, HISTORY_FILE);
    lineCountEstimate = trimmed.length;
  } catch {
    // Clean up temp file on failure
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

export interface PasteInfo {
  offset: number; // char index where paste starts in value
  length: number; // char length of pasted content
  lineCount: number; // number of lines in pasted content
}

interface InputAreaProps {
  onSubmit: (value: string, images: ImageAttachment[], paste?: PasteInfo) => void;
  onAbort: () => void;
  /**
   * Text to push into the composer from outside (e.g. queued messages restored
   * after an interrupt). Bumping `nonce` re-triggers injection even when the
   * text is unchanged. Injected text is appended after any existing draft.
   */
  injectText?: { text: string; nonce: number } | null;
  disabled?: boolean;
  isActive?: boolean;
  onDownAtEnd?: () => void;
  onShiftTab?: () => void;
  onToggleTasks?: () => void;
  taskPickerOpen?: boolean;
  tasks?: readonly TaskRecord[];
  onCloseTaskPicker?: () => void;
  onStartTask?: (task: TaskRecord) => void;
  onRunAllTasks?: (task?: TaskRecord) => void;
  onDeleteTask?: (task: TaskRecord) => void;
  onToggleSkills?: () => void;
  onTogglePixel?: () => void;
  onToggleMarkdown?: () => void;
  cwd: string;
  commands?: SlashCommandInfo[];
  /**
   * Locked badge rendered before the prompt arrow on the first visual line.
   * The user cannot delete or edit it — typed text always follows. Used by
   * downstream tools (gg-boss) to show the active scope/project pill.
   */
  scopeBadge?: React.ReactNode;
  /**
   * Skip the SGR mouse-tracking enable/disable dance entirely. Some terminals
   * (notably Ghostty mid-2026) interpret rapid `\x1b[?1000h` / `\x1b[?1006h`
   * mode toggles as bracketed-paste boundaries, which makes the terminal
   * paste whatever's in the system clipboard repeatedly during high-frequency
   * UI updates (e.g. when workers are running and the input rapidly rerenders).
   * Setting this to true disables click-to-cursor inside the input but kills
   * the phantom-paste bug. Default: false (mouse tracking enabled, ggcoder
   * behaviour preserved).
   */
  disableMouseTracking?: boolean;
  /**
   * Fired when the user presses Tab (outside slash-completion mode). Used by
   * downstream tools (gg-boss) to cycle the scope badge.
   */
  onTab?: () => void;
  /**
   * Fullscreen alt-screen mode: there is no native scrollback, so mouse-wheel
   * events must drive the in-app transcript scroll instead of being passed
   * through to the terminal. When set, wheel-up/down call `onScroll` and mouse
   * tracking is kept enabled regardless of input text so wheel events arrive.
   */
  mouseScroll?: boolean;
  /**
   * Called with a signed line delta when the user scrolls the mouse wheel in
   * fullscreen mode. Positive = scroll UP (older output), negative = DOWN.
   */
  onScroll?: (deltaLines: number) => void;
}

// Lines advanced per mouse-wheel notch in fullscreen transcript scrolling.
const WHEEL_LINES_PER_NOTCH = 3;

// Padding (1 each side) = 2 characters of overhead. Gemini's composer is borderless
// except for a zero-height top rule, so wrapping should not reserve border columns.
const INPUT_HORIZONTAL_OVERHEAD = 2;
// Minimum content width to prevent zero/negative values that cause infinite
// re-render loops when Ink tries to wrap text wider than available space.
const MIN_CONTENT_WIDTH = 10;

/**
 * Split text into visual lines based on terminal width.
 * Accounts for the prompt prefix, border, and padding.
 */
function wrapLine(text: string, contentWidth: number): string[] {
  if (text.length === 0) return [""];
  const lines: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= contentWidth) {
      lines.push(remaining);
      break;
    }

    let breakAt = remaining.lastIndexOf(" ", contentWidth);
    if (breakAt <= 0) {
      breakAt = contentWidth;
      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt);
    } else {
      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt + 1);
    }
  }

  return lines;
}

function getVisualLines(text: string, columns: number): string[] {
  const contentWidth = Math.max(
    MIN_CONTENT_WIDTH,
    columns - PROMPT.length - INPUT_HORIZONTAL_OVERHEAD,
  );
  if (text.length === 0) return [""];

  // Split on real newlines first, then wrap each
  const hardLines = text.split("\n");
  const result: string[] = [];
  for (const line of hardLines) {
    result.push(...wrapLine(line, contentWidth));
  }
  return result;
}

export function InputArea({
  onSubmit,
  onAbort,
  injectText,
  disabled = false,
  isActive = true,
  onDownAtEnd,
  onShiftTab,
  onToggleTasks,
  taskPickerOpen = false,
  tasks = [],
  onCloseTaskPicker,
  onStartTask,
  onRunAllTasks,
  onDeleteTask,
  onToggleSkills,
  onTogglePixel,
  onToggleMarkdown,
  cwd,
  commands = [],
  scopeBadge,
  disableMouseTracking,
  mouseScroll,
  onScroll,
  onTab,
}: InputAreaProps) {
  const theme = useTheme();
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const historyRef = useRef<string[]>(loadHistory());
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");

  // ── External text injection (e.g. queued messages restored on interrupt) ──
  // Append injected text to any existing draft and move the cursor to the end.
  // Keyed on nonce so repeated injections of identical text still fire.
  const lastInjectNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!injectText || injectText.text.length === 0) return;
    if (lastInjectNonceRef.current === injectText.nonce) return;
    lastInjectNonceRef.current = injectText.nonce;
    setValue((prev) => {
      const next = prev.length > 0 ? `${prev}\n\n${injectText.text}` : injectText.text;
      setCursor(next.length);
      return next;
    });
  }, [injectText]);

  // ── Ctrl+R history search state ──────────────────────────
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFailed, setSearchFailed] = useState(false);
  const searchIndexRef = useRef(0);
  const savedInputRef = useRef("");
  const savedCursorRef = useRef(0);

  const findNextMatch = (query: string, startFrom: number) => {
    if (!query) return;
    for (let i = startFrom; i >= 0; i--) {
      if (historyRef.current[i]?.toLowerCase().includes(query.toLowerCase())) {
        searchIndexRef.current = i;
        setValue(historyRef.current[i]);
        const matchPos = historyRef.current[i].toLowerCase().lastIndexOf(query.toLowerCase());
        setCursor(matchPos + query.length);
        setSearchFailed(false);
        return;
      }
    }
    setSearchFailed(true);
  };
  const lastEscRef = useRef(0);
  const { columns } = useTerminalSize();
  const [menuIndex, setMenuIndex] = useState(0);
  const [taskPickerIndex, setTaskPickerIndex] = useState(0);
  const [pasteText, setPasteText] = useState(""); // accumulated pasted content
  const [pasteOffset, setPasteOffset] = useState(0); // where in value the paste starts
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detect if we're in slash command mode
  const isSlashMode = value.startsWith("/") && !value.includes(" ") && commands.length > 0;
  const slashFilter = isSlashMode ? value.slice(1) : "";
  const filteredCommands = useMemo(
    () => (isSlashMode ? filterCommands(commands, slashFilter) : []),
    [isSlashMode, commands, slashFilter],
  );
  const runnableTasks = useMemo(() => tasks.filter((task) => task.status !== "done"), [tasks]);

  // Reset menu index when filter changes
  useEffect(() => {
    setMenuIndex(0);
  }, [slashFilter]);

  useEffect(() => {
    setTaskPickerIndex((index) => Math.min(index, Math.max(0, runnableTasks.length - 1)));
  }, [runnableTasks.length]);

  // Border color pulse (when idle/waiting for input)
  const borderPulseColors = useMemo(
    () => [theme.primary, theme.accent, theme.secondary, theme.accent],
    [theme.primary, theme.accent, theme.secondary],
  );

  // Derive border pulse and cursor blink from global animation tick.
  // Disable it while the agent owns the terminal; otherwise the idle input's
  // cursor/border animation keeps repainting the live area during long runs,
  // which makes terminal scrollback snap back to the bottom.
  const inputAnimationEnabled = !disabled && isActive;
  const { active: inputAnimationActive, tick } = useFocusedAnimation(inputAnimationEnabled);
  const borderFrame = inputAnimationActive ? deriveFrame(tick, 800, borderPulseColors.length) : 0;
  // Cursor blink: ~530ms period → visible for ~500ms, hidden for ~500ms
  const cursorVisible = !inputAnimationActive || deriveFrame(tick, 530, 2) === 0;

  // Auto-detect image paths as they're pasted/typed — debounce so full paste arrives
  const extractingRef = useRef(false);
  useEffect(() => {
    if (!value || extractingRef.current) return;
    const timer = setTimeout(() => {
      extractingRef.current = true;
      extractImagePaths(value, cwd)
        .then(async ({ imagePaths, cleanText }) => {
          if (imagePaths.length === 0) return;
          const newImages: ImageAttachment[] = [];
          for (const imgPath of imagePaths) {
            try {
              newImages.push(await readImageFile(imgPath));
            } catch {
              // Not a valid image file — leave in text
            }
          }
          if (newImages.length > 0) {
            setImages((prev) => [...prev, ...newImages]);
            setValue(cleanText);
            setCursor(Math.min(cursor, cleanText.length));
          }
        })
        .finally(() => {
          extractingRef.current = false;
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [value, cwd, disabled]);

  // Normalize Enter/Tab sequences from terminals that don't speak kitty
  // keyboard protocol cleanly. Two cases handled:
  //
  // 1. Numpad Enter (kitty form: ESC[57414u or ESC[57414;Nu) — Ink parses
  //    this as "kpenter" rather than "return", so key.return is never set.
  // 2. xterm modifyOtherKeys=2 form: ESC[27;<mod>;<keycode>~ — Terminal.app,
  //    older xterms, and some iTerm2 configs send Shift+Enter as
  //    ESC[27;2;13~ when the kitty enable request is ignored. Ink can't
  //    parse this form and the raw bytes leak into the text input.
  //
  // We wrap the internal event emitter so we can both translate the
  // sequence into something Ink recognises AND swallow the original
  // bytes before Ink's parser sees them.
  const { internal_eventEmitter } = useStdin() as ReturnType<typeof useStdin> & {
    internal_eventEmitter: EventEmitter;
  };
  useEffect(() => {
    if (!isActive || !internal_eventEmitter) return;
    // eslint-disable-next-line no-control-regex
    const kpEnterRe = /^\x1b\[57414(;\d+)?u$/;
    // eslint-disable-next-line no-control-regex
    const xtermModifyRe = /^\x1b\[27;(\d+);(\d+)~$/;

    const synthForEnter = (mod: number): string => {
      const hasShift = !!(mod & 1);
      const hasMeta = !!(mod & 10);
      return hasShift ? "\x1b[13;2u" : hasMeta ? "\x1b\r" : "\r";
    };

    const originalEmit = internal_eventEmitter.emit.bind(internal_eventEmitter);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedEmit = (event: string | symbol, ...args: any[]): boolean => {
      if (event === "input" && typeof args[0] === "string") {
        const data = args[0] as string;

        const withoutFocusReports = stripTerminalFocusSequences(data);
        if (!withoutFocusReports) return true;

        if (kpEnterRe.test(withoutFocusReports)) {
          const modMatch = /;(\d+)u$/.exec(withoutFocusReports);
          const mod = modMatch ? Math.max(0, parseInt(modMatch[1], 10) - 1) : 0;
          return originalEmit("input", synthForEnter(mod));
        }

        const xtermMatch = xtermModifyRe.exec(withoutFocusReports);
        if (xtermMatch) {
          const mod = Math.max(0, parseInt(xtermMatch[1], 10) - 1);
          const keycode = parseInt(xtermMatch[2], 10);
          if (keycode === 13) {
            return originalEmit("input", synthForEnter(mod));
          }
          if (keycode === 9) {
            const hasShift = !!(mod & 1);
            return originalEmit("input", hasShift ? "\x1b[Z" : "\t");
          }
          // Unknown keycode in this form — swallow so the raw bytes
          // don't end up in the text field.
          return true;
        }

        if (withoutFocusReports !== data) {
          return originalEmit("input", withoutFocusReports);
        }
      }
      return originalEmit(event, ...args);
    };

    internal_eventEmitter.emit = wrappedEmit as typeof internal_eventEmitter.emit;

    return () => {
      if (internal_eventEmitter.emit === wrappedEmit) {
        internal_eventEmitter.emit = originalEmit as typeof internal_eventEmitter.emit;
      }
    };
  }, [isActive, internal_eventEmitter]);

  // --- Mouse click-to-position-cursor ---
  // Store layout info in a ref so the mouse handler can map terminal
  // coordinates to character offsets without re-subscribing on every change.
  const layoutRef = useRef({
    value: "",
    displayLines: [""] as string[],
    startLine: 0,
    contentWidth: 10,
    columns: 80,
    hasImages: false,
  });

  // Self-calibrating anchor: the terminal row (1-based) of the LAST
  // display line.  We track the last line (not the first) because Ink
  // grows the input box upward — the bottom stays at a stable position
  // while the top moves up as lines are added.  Calibrated on any
  // single-line click (unambiguous), then remains valid as text wraps.
  const lastLineRowRef = useRef(-1);

  // Enable SGR mouse tracking and intercept mouse sequences before Ink's
  // useInput sees them (which would insert the raw escape text).  We wrap
  // the internal event emitter's `emit` so mouse data is consumed here and
  // never forwarded to Ink's input handler.
  const mouseEmitRef = useRef<{
    original: typeof internal_eventEmitter.emit | null;
  }>({ original: null });

  // Track whether input has text so we can toggle mouse tracking.
  // Only enable mouse tracking when there's text to navigate — when the input
  // is empty, click-to-cursor is useless and disabling tracking lets the
  // terminal handle CMD+click for opening links natively.
  const hasInputTextRef = useRef(value.length > 0);

  // Fullscreen wheel-scroll routing. Kept in refs so the emit-wrapper effect
  // (whose deps are intentionally stable) always sees the freshest callback.
  const mouseScrollRef = useRef(mouseScroll);
  mouseScrollRef.current = mouseScroll;
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  // Assigned by the mouse effect; called by the keyboard handler to re-arm
  // mouse tracking after the user finishes a native text selection (see the
  // fullscreen selection-mode logic below). Lifting it out of the effect lets
  // a keystroke — the unambiguous "I'm done selecting" signal — restore the
  // wheel without a fragile timer that would cut a slow selection short.
  const reenableMouseRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!isActive || !internal_eventEmitter) return;
    // Hard-bail when mouse tracking is disabled at the prop level — used by
    // gg-boss to avoid the Ghostty phantom-paste bug where rapid mode toggles
    // get interpreted as bracketed-paste boundaries during high-frequency UI
    // updates (e.g. workers running, status bar shimmering). Without this we
    // skip the wrapper install too, so no escape-sequence stripping happens
    // either — but that's fine, no mouse tracking means no SGR sequences to
    // strip in the first place.
    if (disableMouseTracking) return;

    // Only enable mouse tracking if there's text — when empty, let the
    // terminal handle clicks natively (e.g., CMD+click to open links).
    // In fullscreen mode we always enable it so wheel-scroll events arrive even
    // when the composer is empty (there's no native scrollback to fall back to).
    if (hasInputTextRef.current || mouseScrollRef.current) {
      process.stdout.write(ENABLE_MOUSE);
    }

    // Safety: ensure mouse tracking is disabled even on crash/SIGINT/unexpected exit
    // so the terminal isn't left in a broken state sending escape sequences on every click.
    const onProcessExit = () => process.stdout.write(DISABLE_MOUSE);
    process.on("exit", onProcessExit);

    const originalEmit = internal_eventEmitter.emit.bind(internal_eventEmitter);
    mouseEmitRef.current.original = originalEmit;

    // Mouse-release passthrough: when we want the TERMINAL (not the app) to
    // handle a gesture — native scroll in the legacy model, or native text
    // selection / CMD+click link-opening in fullscreen — we disable mouse
    // tracking so the terminal owns the mouse.
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    let mouseDisabled = false;

    // Re-arm mouse tracking only when something still needs it: there's input
    // text to position a cursor in (legacy click-to-cursor), OR we're in
    // fullscreen where the wheel drives the transcript scroll. Without the
    // fullscreen clause the mouse would stay dead after the first click and the
    // wheel would stop scrolling.
    const reenableMouse = () => {
      if (scrollTimer) {
        clearTimeout(scrollTimer);
        scrollTimer = null;
      }
      if (mouseDisabled && (hasInputTextRef.current || mouseScrollRef.current)) {
        process.stdout.write(ENABLE_MOUSE);
        mouseDisabled = false;
      }
    };
    // Exposed so the keyboard handler can re-arm on the next keystroke.
    reenableMouseRef.current = reenableMouse;

    // Timed release — used for the legacy scroll-passthrough model where a short
    // idle reliably means the wheel gesture is over.
    const pauseMouseTimed = (durationMs: number) => {
      if (!mouseDisabled) {
        process.stdout.write(DISABLE_MOUSE);
        mouseDisabled = true;
      }
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(reenableMouse, durationMs);
    };
    const pauseMouseForScroll = () => pauseMouseTimed(SCROLL_PAUSE_MS);

    // Indefinite release for native selection / link-clicks in fullscreen. NO
    // timer: a text selection can take as long as the user wants, and a timer
    // that re-armed mid-drag would abort the selection. The wheel is restored
    // only when the user presses a key (handled in the keyboard useInput) — an
    // unambiguous signal that they're done selecting and back to driving the
    // app. A long safety-net timer guards against a stuck state if no key ever
    // follows (e.g. they copy and switch windows).
    const pauseMouseForNativeInteraction = () => {
      if (!mouseDisabled) {
        process.stdout.write(DISABLE_MOUSE);
        mouseDisabled = true;
      }
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(reenableMouse, NATIVE_INTERACTION_SAFETY_MS);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    internal_eventEmitter.emit = (event: string | symbol, ...args: any[]): boolean => {
      if (event === "input" && typeof args[0] === "string") {
        const data = args[0] as string;
        // Strip all terminal focus reports and SGR mouse sequences from the data
        const dataWithoutFocusReports = stripTerminalFocusSequences(data);
        const stripped = dataWithoutFocusReports.replace(SGR_MOUSE_RE_G, "");

        // Process each mouse sequence for click handling
        let match: RegExpExecArray | null;
        SGR_MOUSE_RE_G.lastIndex = 0;
        while ((match = SGR_MOUSE_RE_G.exec(data)) !== null) {
          const btnCode = parseInt(match[1], 10);
          const termCol = parseInt(match[2], 10);
          const termRow = parseInt(match[3], 10);
          const isPress = match[4] === "M";

          // Decode SGR button code with bitmask:
          // bits 0-1: button (0=left, 1=middle, 2=right, 3=release)
          // bit 2 (4): shift held
          // bit 3 (8): meta/alt held (CMD on macOS)
          // bit 4 (16): control held
          // bit 5 (32): motion event
          // bit 6 (64): scroll wheel
          const button = btnCode & 3;
          const hasModifier = (btnCode & 0b11100) !== 0; // shift, meta, or ctrl
          const isMotion = (btnCode & 32) !== 0;
          const isScroll = (btnCode & 64) !== 0;

          // On scroll wheel:
          if (isScroll) {
            // Fullscreen alt-screen: no native scrollback exists, so route the
            // wheel into the in-app transcript scroll. Wheel-up (button bit 0
            // clear) scrolls toward older output, wheel-down toward newest.
            if (mouseScrollRef.current && onScrollRef.current) {
              const wheelUp = (btnCode & 1) === 0;
              onScrollRef.current(wheelUp ? WHEEL_LINES_PER_NOTCH : -WHEEL_LINES_PER_NOTCH);
              continue;
            }
            // Legacy scrollback model: disable mouse tracking so the terminal
            // handles it natively, then re-enable after idle.
            pauseMouseForScroll();
            continue;
          }

          // Fullscreen: the wheel is the ONLY gesture we capture. Any other
          // mouse event means the user wants to interact with the terminal
          // itself — drag to select/copy text, or CMD+click a link. Release the
          // mouse so the terminal handles it natively, then re-arm for the
          // wheel after an idle window. (We trade away composer click-to-cursor
          // in fullscreen; the keyboard positions the cursor, and copy/paste +
          // links matter more.)
          if (mouseScrollRef.current) {
            pauseMouseForNativeInteraction();
            continue;
          }

          // When modifier keys are held (CMD+click, Ctrl+click, Shift+click),
          // temporarily disable mouse tracking so the terminal can handle
          // the click natively (e.g., opening links with CMD+click).
          if (hasModifier) {
            pauseMouseForScroll();
            continue;
          }

          // Only handle left-click press (button 0), not motion or release
          if (button !== 0 || isMotion || !isPress) continue;

          const layout = layoutRef.current;
          if (!layout.value && layout.displayLines.length <= 1 && !layout.displayLines[0]) continue;

          const numDisplayLines = layout.displayLines.length;

          // Calibrate on single-line click (unambiguous — the clicked row
          // IS the last (and only) display line's terminal row).
          if (numDisplayLines === 1) {
            lastLineRowRef.current = termRow;
          }

          // Determine which display line was clicked by computing from the
          // last line's row (stable because Ink grows the box upward).
          let clickedDisplayLine: number;
          if (lastLineRowRef.current > 0) {
            const firstLineRow = lastLineRowRef.current - numDisplayLines + 1;
            clickedDisplayLine = termRow - firstLineRow;
            // If calibration is stale (click outside valid range), recalibrate.
            if (clickedDisplayLine < 0) {
              lastLineRowRef.current = termRow + (numDisplayLines - 1);
              clickedDisplayLine = 0;
            } else if (clickedDisplayLine >= numDisplayLines) {
              lastLineRowRef.current = termRow;
              clickedDisplayLine = numDisplayLines - 1;
            }
          } else {
            // Not calibrated yet — assume click is on the last display line.
            // This calibrates correctly because the bottom is stable in Ink.
            lastLineRowRef.current = termRow;
            clickedDisplayLine = numDisplayLines - 1;
          }

          log("INFO", "mouse", "click", {
            termRow,
            termCol,
            lastLineRow: lastLineRowRef.current,
            clickedDisplayLine,
            numDisplayLines,
          });

          // Clamp to valid range
          if (clickedDisplayLine < 0) clickedDisplayLine = 0;
          if (clickedDisplayLine >= numDisplayLines) clickedDisplayLine = numDisplayLines - 1;

          // Column within the text: subtract border(1) + padding(1) + prompt(2) = 4
          const textCol = termCol - 1 - 4;
          const line = layout.displayLines[clickedDisplayLine];
          const col = Math.max(0, Math.min(textCol, line.length));

          // Convert display line + col to absolute character offset
          const { value: val, startLine: sl, contentWidth: cw } = layout;
          const hardLines = val.split("\n");
          let charOffset = 0;
          let vlIndex = 0;
          let found = false;
          for (let h = 0; h < hardLines.length; h++) {
            const hardLine = hardLines[h];
            const wrapped = wrapLine(hardLine, cw > 0 ? cw : val.length + 1);
            let hardLinePos = 0;
            for (let w = 0; w < wrapped.length; w++) {
              if (vlIndex === sl + clickedDisplayLine) {
                setCursor(Math.min(charOffset + col, val.length));
                setSelectionAnchor(null);
                found = true;
                break;
              }
              charOffset += wrapped[w].length;
              hardLinePos += wrapped[w].length;
              // Account for the space consumed by word-wrap break
              if (
                w < wrapped.length - 1 &&
                hardLinePos < hardLine.length &&
                hardLine[hardLinePos] === " "
              ) {
                charOffset++;
                hardLinePos++;
              }
              vlIndex++;
            }
            if (found) break;
            charOffset++; // newline
          }
        }

        // Forward non-mouse data (if any remains) to Ink
        if (stripped) {
          return originalEmit("input", stripped);
        }
        return true; // swallowed entirely
      }
      return originalEmit(event, ...args);
    };

    return () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      reenableMouseRef.current = () => {};
      process.stdout.write(DISABLE_MOUSE);
      process.removeListener("exit", onProcessExit);
      // Restore original emit
      if (mouseEmitRef.current.original) {
        internal_eventEmitter.emit = mouseEmitRef.current.original;
        mouseEmitRef.current.original = null;
      }
    };
  }, [isActive, internal_eventEmitter]);

  // Toggle mouse tracking based on input text: disable when empty so the
  // terminal handles CMD+click for links natively, enable when there's text
  // so click-to-cursor works.
  useEffect(() => {
    if (disableMouseTracking) return;
    const hasText = value.length > 0;
    if (hasText !== hasInputTextRef.current) {
      hasInputTextRef.current = hasText;
      // In fullscreen mode mouse tracking stays on regardless of input text so
      // wheel-scroll keeps working with an empty composer — never disable it.
      if (isActive && !mouseScroll) {
        process.stdout.write(hasText ? ENABLE_MOUSE : DISABLE_MOUSE);
      }
    }
  }, [value, isActive, mouseScroll]);

  // Helper: delete selected text and return new value + cursor position.
  // Returns null if no selection is active.
  const deleteSelection = (): { newValue: string; newCursor: number } | null => {
    const sel = getSelectionRange(selectionAnchor, cursor);
    if (!sel) return null;
    const [start, end] = sel;
    return { newValue: value.slice(0, start) + value.slice(end), newCursor: start };
  };

  // Helper: clear all input state (used on submit / Ctrl+C / Escape)
  const clearInput = () => {
    setValue("");
    setCursor(0);
    setSelectionAnchor(null);
    setImages([]);
    setPasteText("");
  };

  useInput(
    (input, key) => {
      // Filter out stray mouse escape sequences so they don't get inserted as text
      const inputWithoutFocusReports = stripTerminalFocusSequences(input);
      if (!inputWithoutFocusReports && input) return;
      if (isMouseEscapeSequence(inputWithoutFocusReports)) return;

      // A real keystroke is the "I'm done selecting" signal: re-arm mouse
      // tracking (no-op if it was never released) so the wheel works again.
      // This is why native selection can take as long as the user wants — it's
      // ended by intent (a key) rather than a timer that could cut it short.
      reenableMouseRef.current();

      // Reset kill ring accumulation for non-kill keys
      input = inputWithoutFocusReports;
      const isReturnKey = key.return || input === "\r" || input === "\n";

      const isKillKey = key.ctrl && (input === "k" || input === "u" || input === "w");
      if (!isKillKey) lastActionWasKill = false;
      const isYankKey = (key.ctrl && input === "y") || (key.meta && input === "y");
      if (!isYankKey) lastActionWasYank = false;

      // Reset history navigation when any non-arrow key is pressed while browsing
      if (historyIndexRef.current !== -1 && !key.upArrow && !key.downArrow) {
        historyIndexRef.current = -1;
        draftRef.current = "";
      }

      // ── Ctrl+R history search mode ───────────────────────
      if (key.ctrl && input === "r" && !disabled) {
        if (!searchMode) {
          savedInputRef.current = value;
          savedCursorRef.current = cursor;
          setSearchMode(true);
          setSearchQuery("");
          setSearchFailed(false);
          searchIndexRef.current = historyRef.current.length;
        } else {
          // Already searching — find next match
          findNextMatch(searchQuery, searchIndexRef.current - 1);
        }
        return;
      }

      // When search mode is active, intercept all keystrokes
      if (searchMode) {
        if (key.escape || (key.ctrl && input === "g")) {
          // Cancel — restore original
          setSearchMode(false);
          setValue(savedInputRef.current);
          setCursor(savedCursorRef.current);
          return;
        }
        if (isReturnKey) {
          // Accept match and submit
          setSearchMode(false);
          return; // fall through to normal submit handling
        }
        if (key.backspace || key.delete) {
          const newQuery = searchQuery.slice(0, -1);
          setSearchQuery(newQuery);
          if (!newQuery) {
            setSearchMode(false);
            setValue(savedInputRef.current);
            setCursor(savedCursorRef.current);
          } else {
            searchIndexRef.current = historyRef.current.length;
            findNextMatch(newQuery, searchIndexRef.current - 1);
          }
          return;
        }
        if (
          key.rightArrow ||
          (key.ctrl && input === "f") ||
          (key.ctrl && input === "a") ||
          (key.ctrl && input === "e")
        ) {
          // Accept match, exit search, keep value
          setSearchMode(false);
          return;
        }
        // Regular character — append to search query
        if (input.length === 1 && !key.ctrl && !key.meta) {
          const newQuery = searchQuery + input;
          setSearchQuery(newQuery);
          searchIndexRef.current = historyRef.current.length;
          findNextMatch(newQuery, searchIndexRef.current - 1);
          return;
        }
        return; // absorb all other keys during search
      }

      if (taskPickerOpen) {
        if (key.escape || (key.ctrl && input === "t")) {
          onCloseTaskPicker?.();
          return;
        }
        if (key.upArrow) {
          setTaskPickerIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setTaskPickerIndex((i) => Math.min(runnableTasks.length - 1, i + 1));
          return;
        }
        if (input.toLowerCase() === "r") {
          const task = runnableTasks[Math.min(taskPickerIndex, runnableTasks.length - 1)];
          onRunAllTasks?.(task);
          return;
        }
        if (input.toLowerCase() === "d") {
          const task = runnableTasks[Math.min(taskPickerIndex, runnableTasks.length - 1)];
          if (task) onDeleteTask?.(task);
          return;
        }
        if (isReturnKey) {
          const task = runnableTasks[Math.min(taskPickerIndex, runnableTasks.length - 1)];
          if (task) onStartTask?.(task);
          return;
        }
        return;
      }

      // Ctrl+T toggles task picker
      if (key.ctrl && input === "t") {
        onToggleTasks?.();
        return;
      }

      // Ctrl+S toggles skills overlay
      if (key.ctrl && input === "s") {
        onToggleSkills?.();
        return;
      }

      // Ctrl+E toggles pixel (errors) overlay
      if (key.ctrl && input === "e") {
        onTogglePixel?.();
        return;
      }

      // Ctrl+M toggles rendered/raw markdown mode, matching Gemini's raw markdown affordance.
      if (key.ctrl && input === "m") {
        onToggleMarkdown?.();
        return;
      }

      if (disabled) {
        if ((key.ctrl && input === "c") || key.escape) {
          onAbort();
          return;
        }
        // When disabled (agent running), allow typing AND submission.
        // Submitted messages will be queued by the parent component.
      }

      if (isReturnKey && (key.shift || key.meta)) {
        // If there's a selection, replace it with the newline
        const sel = deleteSelection();
        if (sel) {
          setValue(sel.newValue.slice(0, sel.newCursor) + "\n" + sel.newValue.slice(sel.newCursor));
          setCursor(sel.newCursor + 1);
        } else {
          setValue((v) => v.slice(0, cursor) + "\n" + v.slice(cursor));
          setCursor((c) => c + 1);
        }
        setSelectionAnchor(null);
        return;
      }

      if (isReturnKey) {
        // If slash menu is open and a command is selected, fill it in
        if (isSlashMode && filteredCommands.length > 0) {
          const selected = filteredCommands[Math.min(menuIndex, filteredCommands.length - 1)];
          const cmd = "/" + selected.name;
          // Submit the command directly
          const hist = historyRef.current;
          if (hist[hist.length - 1] !== cmd) hist.push(cmd);
          appendHistory(cmd, hist);
          historyIndexRef.current = -1;
          onSubmit(cmd, []);
          clearInput();
          return;
        }

        const trimmed = value.trim();
        if (trimmed || images.length > 0) {
          if (trimmed) {
            const hist = historyRef.current;
            if (hist[hist.length - 1] !== trimmed) hist.push(trimmed);
            appendHistory(trimmed, hist);
          }
          historyIndexRef.current = -1;
          // Compute paste info adjusted for trimming
          const trimLeading = value.length - value.trimStart().length;
          const paste: PasteInfo | undefined =
            pasteText && pasteText.includes("\n")
              ? {
                  offset: Math.max(0, pasteOffset - trimLeading),
                  length: pasteText.length,
                  lineCount: pasteText.split("\n").length,
                }
              : undefined;
          onSubmit(trimmed, [...images], paste);
          clearInput();
        }
        return;
      }

      // Ctrl+V — paste image from clipboard
      if (key.ctrl && input === "v") {
        getClipboardImage().then((img) => {
          if (img) setImages((prev) => [...prev, img]);
        });
        return;
      }

      if (key.ctrl && input === "c") {
        if (value || images.length > 0) {
          clearInput();
        } else {
          onAbort();
        }
        return;
      }

      if (key.ctrl && input === "d") {
        process.exit(0);
      }

      // Ctrl+W — kill previous word → push to kill ring
      if (key.ctrl && input === "w") {
        const sel = deleteSelection();
        if (sel) {
          setValue(sel.newValue);
          setCursor(sel.newCursor);
        } else if (cursor > 0) {
          const boundary = prevWordBoundary(value, cursor);
          const killed = value.slice(boundary, cursor);
          pushKill(killed, "prepend");
          setValue((v) => v.slice(0, boundary) + v.slice(cursor));
          setCursor(boundary);
        }
        setSelectionAnchor(null);
        return;
      }

      // Ctrl+K — kill from cursor to end of line → push to kill ring
      if (key.ctrl && input === "k") {
        const killed = value.slice(cursor);
        if (killed) {
          pushKill(killed, "append");
          setValue(value.slice(0, cursor));
        }
        return;
      }

      // Ctrl+U — kill from cursor to start of line → push to kill ring
      if (key.ctrl && input === "u") {
        const killed = value.slice(0, cursor);
        if (killed) {
          pushKill(killed, "prepend");
          setValue(value.slice(cursor));
          setCursor(0);
        }
        return;
      }

      // Ctrl+Y — yank from kill ring
      if (key.ctrl && input === "y") {
        const text = yankText();
        if (text) {
          const start = cursor;
          setValue(value.slice(0, cursor) + text + value.slice(cursor));
          setCursor(cursor + text.length);
          recordYank(start, text.length);
        }
        return;
      }

      // Alt+Y — yank-pop: cycle through kill ring after a yank
      if (key.meta && input === "y") {
        const pop = yankPop();
        if (pop) {
          const before = value.slice(0, pop.start);
          const after = value.slice(pop.start + pop.length);
          setValue(before + pop.text + after);
          setCursor(pop.start + pop.text.length);
        }
        return;
      }

      // Home / End — Shift extends selection
      if (key.ctrl && input === "a") {
        if (key.shift) {
          if (selectionAnchor === null) setSelectionAnchor(cursor);
        } else {
          setSelectionAnchor(null);
        }
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        if (key.shift) {
          if (selectionAnchor === null) setSelectionAnchor(cursor);
        } else {
          setSelectionAnchor(null);
        }
        setCursor(value.length);
        return;
      }

      if (key.backspace || key.delete) {
        // If selection active, delete the selection
        const sel = deleteSelection();
        if (sel) {
          setValue(sel.newValue);
          setCursor(sel.newCursor);
          setSelectionAnchor(null);
          return;
        }
        if (cursor > 0) {
          setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
          setCursor((c) => c - 1);
        } else if (!value && images.length > 0) {
          setImages((prev) => prev.slice(0, -1));
        }
        setSelectionAnchor(null);
        return;
      }

      if (key.upArrow) {
        if (taskPickerOpen) {
          setTaskPickerIndex((i) => Math.max(0, i - 1));
          return;
        }

        // If slash menu is open, navigate it
        if (isSlashMode && filteredCommands.length > 0) {
          setMenuIndex((i) => Math.max(0, i - 1));
          return;
        }

        // If there's multi-line text, try moving cursor up first
        if (value.includes("\n") && historyIndexRef.current === -1) {
          const before = value.slice(0, cursor);
          const lineStart = before.lastIndexOf("\n");
          if (lineStart !== -1) {
            // Move cursor to same column on previous line
            const col = cursor - lineStart - 1;
            const prevLineStart = before.lastIndexOf("\n", lineStart - 1);
            const prevLineLen = lineStart - (prevLineStart + 1);
            setCursor(prevLineStart + 1 + Math.min(col, prevLineLen));
            setSelectionAnchor(null);
            return;
          }
          // Cursor is on the first line — fall through to history
        }

        // Only navigate history when input is empty or already browsing history
        if (value && historyIndexRef.current === -1) return;

        setSelectionAnchor(null);
        const history = historyRef.current;
        if (history.length === 0) return;

        // Save draft when first entering history mode
        if (historyIndexRef.current === -1) {
          draftRef.current = value;
        }

        const newIndex =
          historyIndexRef.current === -1
            ? history.length - 1
            : Math.max(0, historyIndexRef.current - 1);
        historyIndexRef.current = newIndex;
        setValue(history[newIndex]);
        setCursor(history[newIndex].length);
        return;
      }

      if (key.downArrow) {
        if (taskPickerOpen) {
          setTaskPickerIndex((i) => Math.min(runnableTasks.length - 1, i + 1));
          return;
        }

        // If slash menu is open, navigate it
        if (isSlashMode && filteredCommands.length > 0) {
          setMenuIndex((i) => Math.min(filteredCommands.length - 1, i + 1));
          return;
        }

        // If there's multi-line text, try moving cursor down first
        if (value.includes("\n") && historyIndexRef.current === -1) {
          const before = value.slice(0, cursor);
          const after = value.slice(cursor);
          const nextNewline = after.indexOf("\n");
          if (nextNewline !== -1) {
            // Move cursor to same column on next line
            const lineStart = before.lastIndexOf("\n") + 1;
            const col = cursor - lineStart;
            const nextLineStart = cursor + nextNewline + 1;
            const nextLineEnd = value.indexOf("\n", nextLineStart);
            const nextLineLen = (nextLineEnd === -1 ? value.length : nextLineEnd) - nextLineStart;
            setCursor(nextLineStart + Math.min(col, nextLineLen));
            setSelectionAnchor(null);
            return;
          }
          // Cursor is on the last line — fall through, but don't navigate history
          // since we have actual content typed
          if (onDownAtEnd) onDownAtEnd();
          return;
        }

        setSelectionAnchor(null);
        const history = historyRef.current;
        if (historyIndexRef.current === -1) {
          if (onDownAtEnd) onDownAtEnd();
          return;
        }
        const newIndex = historyIndexRef.current + 1;
        if (newIndex >= history.length) {
          historyIndexRef.current = -1;
          setValue(draftRef.current);
          setCursor(draftRef.current.length);
          draftRef.current = "";
        } else {
          historyIndexRef.current = newIndex;
          setValue(history[newIndex]);
          setCursor(history[newIndex].length);
        }
        return;
      }

      if (key.escape) {
        // First escape clears selection, second clears input (double-tap)
        if (selectionAnchor !== null) {
          setSelectionAnchor(null);
          lastEscRef.current = Date.now();
          return;
        }
        const now = Date.now();
        if ((value || images.length > 0) && now - lastEscRef.current < 400) {
          clearInput();
        }
        lastEscRef.current = now;
        return;
      }

      if (key.tab && key.shift) {
        onShiftTab?.();
        return;
      }

      // Tab completion for slash commands
      if (key.tab) {
        if (isSlashMode && filteredCommands.length > 0) {
          const selected = filteredCommands[Math.min(menuIndex, filteredCommands.length - 1)];
          const cmd = "/" + selected.name;
          setValue(cmd);
          setCursor(cmd.length);
          setSelectionAnchor(null);
          return;
        }
        // Outside slash mode, Tab is delegated — used by gg-boss to cycle
        // the scope badge.
        onTab?.();
        return;
      }

      // Option+Arrow word jump via raw escape sequences — many terminals send
      // these as input strings rather than setting key.meta + arrow reliably.
      if (OPTION_LEFT_SEQUENCES.has(input)) {
        if (selectionAnchor !== null) {
          const sel = getSelectionRange(selectionAnchor, cursor);
          if (sel) setCursor(sel[0]);
          setSelectionAnchor(null);
        } else {
          setCursor(prevWordBoundary(value, cursor));
        }
        return;
      }
      if (OPTION_RIGHT_SEQUENCES.has(input)) {
        if (selectionAnchor !== null) {
          const sel = getSelectionRange(selectionAnchor, cursor);
          if (sel) setCursor(sel[1]);
          setSelectionAnchor(null);
        } else {
          setCursor(nextWordBoundary(value, cursor));
        }
        return;
      }

      // Arrow keys — Shift extends selection, Meta/Option jumps words
      if (key.leftArrow) {
        if (key.shift) {
          if (selectionAnchor === null) setSelectionAnchor(cursor);
        } else if (selectionAnchor !== null) {
          // Collapse selection to the left edge
          const sel = getSelectionRange(selectionAnchor, cursor);
          if (sel) setCursor(sel[0]);
          setSelectionAnchor(null);
          return;
        }
        if (key.meta) {
          setCursor(prevWordBoundary(value, cursor));
        } else if (cursor > 0) {
          setCursor((c) => c - 1);
        }
        if (!key.shift) setSelectionAnchor(null);
        return;
      }

      if (key.rightArrow) {
        if (key.shift) {
          if (selectionAnchor === null) setSelectionAnchor(cursor);
        } else if (selectionAnchor !== null) {
          // Collapse selection to the right edge
          const sel = getSelectionRange(selectionAnchor, cursor);
          if (sel) setCursor(sel[1]);
          setSelectionAnchor(null);
          return;
        }
        if (key.meta) {
          setCursor(nextWordBoundary(value, cursor));
        } else if (cursor < value.length) {
          setCursor((c) => c + 1);
        }
        if (!key.shift) setSelectionAnchor(null);
        return;
      }

      if (input) {
        const normalized = input.replace(/\r\n?/g, "\n");

        // If there's a selection, replace it with the typed input
        const sel = deleteSelection();
        if (sel) {
          setValue(
            sel.newValue.slice(0, sel.newCursor) + normalized + sel.newValue.slice(sel.newCursor),
          );
          const newCur = sel.newCursor + normalized.length;
          setCursor(newCur);
          cursorRef.current = newCur;
          setSelectionAnchor(null);
        } else {
          const cur = cursorRef.current;
          setValue((v) => v.slice(0, cur) + normalized + v.slice(cur));
          setCursor(cur + normalized.length);
          cursorRef.current = cur + normalized.length;
        }

        // Detect paste: Ink delivers pasted text as input.length > 1
        // For large pastes, Ink may split into multiple chunks, so we
        // accumulate and debounce to capture the full paste.
        if (input.length > 1) {
          const pasteStart = sel ? sel.newCursor : cursorRef.current - normalized.length;
          setPasteText((prev) => {
            if (!prev) setPasteOffset(pasteStart);
            return prev + normalized;
          });
          if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current);
          pasteTimerRef.current = setTimeout(() => {
            // After 100ms of quiet, finalize: only keep paste state if it had newlines
            setPasteText((p) => (p.includes("\n") ? p : ""));
            pasteTimerRef.current = null;
          }, 100);
        }
      }
    },
    { isActive },
  );

  // Calculate visual lines and cap at MAX_VISIBLE_LINES (scroll to cursor)
  const visualLines = getVisualLines(value, columns);
  const contentWidth = Math.max(
    MIN_CONTENT_WIDTH,
    columns - PROMPT.length - INPUT_HORIZONTAL_OVERHEAD,
  );

  // Find which visual line and column the cursor is on
  const cursorLineInfo = useMemo(() => {
    let pos = 0;
    const hardLines = value.split("\n");
    let visualLineIndex = 0;
    for (let h = 0; h < hardLines.length; h++) {
      const hardLine = hardLines[h];
      const wrapped = wrapLine(hardLine, contentWidth);
      let hardLinePos = 0; // track position within the original hard line
      for (let w = 0; w < wrapped.length; w++) {
        const lineLen = wrapped[w].length;
        const lineStart = pos;
        const lineEnd = pos + lineLen;
        if (cursor >= lineStart && cursor <= lineEnd) {
          return { line: visualLineIndex, col: cursor - lineStart };
        }
        pos += lineLen;
        hardLinePos += lineLen;
        // Account for the space consumed by word-wrap break
        if (
          w < wrapped.length - 1 &&
          hardLinePos < hardLine.length &&
          hardLine[hardLinePos] === " "
        ) {
          pos++;
          hardLinePos++;
        }
        visualLineIndex++;
      }
      pos++; // newline character
    }
    // Fallback: cursor at end
    return { line: visualLines.length - 1, col: visualLines[visualLines.length - 1]?.length ?? 0 };
  }, [value, cursor, contentWidth, visualLines]);

  // Scroll window to keep cursor visible
  const totalLines = visualLines.length;
  let startLine: number;
  if (totalLines <= MAX_VISIBLE_LINES) {
    startLine = 0;
  } else {
    // Ensure the cursor line is visible
    const cursorLine = cursorLineInfo.line;
    // Try to keep current scroll position, but adjust if cursor is out of view
    const idealStart = Math.max(0, cursorLine - MAX_VISIBLE_LINES + 1);
    startLine = Math.min(idealStart, totalLines - MAX_VISIBLE_LINES);
  }
  const displayLines = visualLines.slice(startLine, startLine + MAX_VISIBLE_LINES);
  const cursorDisplayLine = cursorLineInfo.line - startLine;

  // Keep layout ref in sync for mouse click handler
  layoutRef.current.value = value;
  layoutRef.current.displayLines = displayLines;
  layoutRef.current.startLine = startLine;
  layoutRef.current.contentWidth = contentWidth;
  layoutRef.current.columns = columns;
  layoutRef.current.hasImages = images.length > 0;

  // Determine if the input starts with a slash command and find command boundary
  const isCommand = value.startsWith("/");
  // Command portion ends at first space (e.g., "/research" in "/research some args")
  const commandEndIndex = isCommand
    ? value.indexOf(" ") === -1
      ? value.length
      : value.indexOf(" ")
    : 0;

  // Active selection range (absolute character offsets)
  const selection = getSelectionRange(selectionAnchor, cursor);

  const promptColor = disabled ? theme.textDim : theme.commandColor;
  const borderColor = disabled ? theme.textDim : borderPulseColors[borderFrame];
  const backgroundColor = isScreenReaderEnabled ? undefined : INPUT_BACKGROUND;
  const renderInputEdge = (fill: string): React.ReactNode => (
    <Box width={columns}>
      <Text color={backgroundColor ?? borderColor}>{fill.repeat(columns)}</Text>
    </Box>
  );

  const renderPromptPrefix = (text: string): React.ReactNode => (
    <Text color={promptColor} bold backgroundColor={backgroundColor}>
      {text}
    </Text>
  );

  return (
    <Box flexDirection="column" width={columns} flexGrow={0} flexShrink={0}>
      {renderInputEdge(backgroundColor ? INPUT_TOP_FILL : "─")}
      <Box
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        flexGrow={0}
        flexShrink={0}
        backgroundColor={backgroundColor}
        width={columns}
      >
        {scopeBadge && <Box marginBottom={0}>{scopeBadge}</Box>}
        {images.length > 0 && (
          <Box>
            <Text color={theme.accent}>
              {images
                .map((img, i) =>
                  img.kind === "text" ? `[File: ${img.fileName}]` : `[Image #${i + 1}]`,
                )
                .join(" ")}
            </Text>
          </Box>
        )}
        {(() => {
          if (pasteText && value) {
            const pasteLineCount = pasteText.split("\n").length;
            const indicator = `[Pasted text #${pasteText.length} +${pasteLineCount} lines]`;
            const pasteLen = pasteText.length;
            const typedBefore = value.slice(0, pasteOffset);
            const typedAfter = value.slice(pasteOffset + pasteLen);
            const displayStr = typedBefore + indicator + typedAfter;

            // Map real cursor to display cursor
            let cursorInDisplay: number;
            if (cursor <= pasteOffset) {
              cursorInDisplay = cursor;
            } else if (cursor >= pasteOffset + pasteLen) {
              cursorInDisplay = cursor - pasteLen + indicator.length;
            } else {
              cursorInDisplay = pasteOffset + indicator.length;
            }

            return (
              <Box backgroundColor={backgroundColor} width="100%">
                {searchMode ? (
                  <Text
                    color={searchFailed ? theme.error : theme.inputPrompt}
                    bold
                    backgroundColor={backgroundColor}
                  >
                    {searchFailed ? "(fail)" : "(i-search)"}
                    {`'${searchQuery}': `}
                  </Text>
                ) : (
                  renderPromptPrefix(PROMPT)
                )}
                {(() => {
                  const beforeCursor = displayStr.slice(0, cursorInDisplay);
                  const renderDisplaySegment = (text: string, displayOffset: number) => {
                    if (!text) return null;
                    const inCmd = isCommand && displayOffset < commandEndIndex;
                    const cmdChars = inCmd
                      ? Math.min(text.length, commandEndIndex - displayOffset)
                      : 0;
                    if (cmdChars >= text.length) {
                      return (
                        <Text color={theme.commandColor} bold backgroundColor={backgroundColor}>
                          {text}
                        </Text>
                      );
                    }
                    if (cmdChars > 0) {
                      return (
                        <>
                          <Text color={theme.commandColor} bold backgroundColor={backgroundColor}>
                            {text.slice(0, cmdChars)}
                          </Text>
                          <Text color={theme.commandColor} backgroundColor={backgroundColor}>
                            {text.slice(cmdChars)}
                          </Text>
                        </>
                      );
                    }
                    return (
                      <Text color={theme.commandColor} backgroundColor={backgroundColor}>
                        {text}
                      </Text>
                    );
                  };
                  return renderDisplaySegment(beforeCursor, 0);
                })()}
                {(() => {
                  const cursorChar =
                    cursorInDisplay < displayStr.length ? displayStr[cursorInDisplay] : " ";
                  const cursorInCmd = isCommand && cursorInDisplay < commandEndIndex;
                  return (
                    <Text
                      color={theme.commandColor}
                      bold={cursorInCmd || undefined}
                      inverse={cursorVisible}
                      backgroundColor={backgroundColor}
                    >
                      {cursorChar}
                    </Text>
                  );
                })()}
                {cursorInDisplay + 1 < displayStr.length &&
                  (() => {
                    const afterCursor = displayStr.slice(cursorInDisplay + 1);
                    const afterOffset = cursorInDisplay + 1;
                    const inCmd = isCommand && afterOffset < commandEndIndex;
                    const cmdChars = inCmd
                      ? Math.min(afterCursor.length, commandEndIndex - afterOffset)
                      : 0;
                    if (cmdChars >= afterCursor.length) {
                      return (
                        <Text color={theme.commandColor} bold>
                          {afterCursor}
                        </Text>
                      );
                    }
                    if (cmdChars > 0) {
                      return (
                        <>
                          <Text color={theme.commandColor} bold>
                            {afterCursor.slice(0, cmdChars)}
                          </Text>
                          <Text color={theme.commandColor} backgroundColor={backgroundColor}>
                            {afterCursor.slice(cmdChars)}
                          </Text>
                        </>
                      );
                    }
                    return (
                      <Text color={theme.commandColor} backgroundColor={backgroundColor}>
                        {afterCursor}
                      </Text>
                    );
                  })()}
              </Box>
            );
          }

          if (value.length === 0) {
            return (
              <Box backgroundColor={backgroundColor} width="100%">
                {renderPromptPrefix(PROMPT)}
                <Text
                  color={theme.textDim}
                  inverse={cursorVisible}
                  backgroundColor={backgroundColor}
                >
                  {PLACEHOLDER.slice(0, 1)}
                </Text>
                <Text color={theme.textDim} backgroundColor={backgroundColor}>
                  {PLACEHOLDER.slice(1)}
                </Text>
              </Box>
            );
          }

          return displayLines.map((line, i) => {
            const showCursor = i === cursorDisplayLine;
            const col = cursorLineInfo.col;

            // Calculate the absolute character offset where this display line starts
            let lineStartOffset = 0;
            const hardLines = value.split("\n");
            let offset = 0;
            let vlIndex = 0;
            for (let h = 0; h < hardLines.length && vlIndex <= startLine + i; h++) {
              const hardLine = hardLines[h];
              const cw = contentWidth > 0 ? contentWidth : value.length + 1;
              const wrapped = wrapLine(hardLine, cw);
              let hardLinePos = 0;
              for (let w = 0; w < wrapped.length && vlIndex <= startLine + i; w++) {
                if (vlIndex === startLine + i) {
                  lineStartOffset = offset;
                }
                offset += wrapped[w].length;
                hardLinePos += wrapped[w].length;
                // Account for the space consumed by word-wrap break
                if (
                  w < wrapped.length - 1 &&
                  hardLinePos < hardLine.length &&
                  hardLine[hardLinePos] === " "
                ) {
                  offset++;
                  hardLinePos++;
                }
                vlIndex++;
              }
              offset++; // newline
            }

            const lineEndOffset = lineStartOffset + line.length;

            // Render a text segment with command coloring and optional selection highlight
            const renderSegment = (
              text: string,
              absOffset: number,
              opts?: { inverse?: boolean },
            ) => {
              if (!text) return null;
              const inCmd = isCommand && absOffset < commandEndIndex;
              const cmdChars = inCmd ? Math.min(text.length, commandEndIndex - absOffset) : 0;
              const inv = opts?.inverse ?? false;

              if (cmdChars >= text.length) {
                return (
                  <Text
                    color={theme.commandColor}
                    bold
                    inverse={inv}
                    backgroundColor={backgroundColor}
                  >
                    {text}
                  </Text>
                );
              }
              if (cmdChars > 0) {
                return (
                  <>
                    <Text
                      color={theme.commandColor}
                      bold
                      inverse={inv}
                      backgroundColor={backgroundColor}
                    >
                      {text.slice(0, cmdChars)}
                    </Text>
                    <Text
                      color={theme.commandColor}
                      inverse={inv}
                      backgroundColor={backgroundColor}
                    >
                      {text.slice(cmdChars)}
                    </Text>
                  </>
                );
              }
              return (
                <Text color={theme.commandColor} inverse={inv} backgroundColor={backgroundColor}>
                  {text}
                </Text>
              );
            };

            // Build segments for: [before-sel] [selected] [cursor] [after-sel]
            // considering that cursor and selection can overlap on this line
            const segments: React.ReactNode[] = [];
            let pos = 0; // position within `line`

            // Determine selection overlap with this line (in line-local coords)
            const selLocalStart = selection
              ? Math.max(0, selection[0] - lineStartOffset)
              : line.length;
            const selLocalEnd = selection
              ? Math.min(line.length, selection[1] - lineStartOffset)
              : line.length;
            const hasSelOnLine =
              selection !== null && selection[0] < lineEndOffset && selection[1] > lineStartOffset;

            if (hasSelOnLine) {
              // Text before selection
              if (selLocalStart > 0) {
                segments.push(
                  <React.Fragment key="pre">
                    {renderSegment(line.slice(0, selLocalStart), lineStartOffset)}
                  </React.Fragment>,
                );
                pos = selLocalStart;
              }

              // Selected text — render with inverse, but split around cursor if needed
              if (showCursor && col >= selLocalStart && col < selLocalEnd) {
                // Cursor is inside the selection
                if (col > pos) {
                  segments.push(
                    <React.Fragment key="sel-before">
                      {renderSegment(line.slice(pos, col), lineStartOffset + pos, {
                        inverse: true,
                      })}
                    </React.Fragment>,
                  );
                }
                // Cursor character (blinks within selection)
                const cursorChar = col < line.length ? line[col] : " ";
                const cursorAbs = lineStartOffset + col;
                const curInCmd = isCommand && cursorAbs < commandEndIndex;
                segments.push(
                  <Text
                    key="cursor"
                    color={theme.commandColor}
                    bold={curInCmd}
                    inverse={cursorVisible}
                    backgroundColor={backgroundColor}
                  >
                    {cursorChar}
                  </Text>,
                );
                const afterCursorPos = col + (col < line.length ? 1 : 0);
                if (afterCursorPos < selLocalEnd) {
                  segments.push(
                    <React.Fragment key="sel-after">
                      {renderSegment(
                        line.slice(afterCursorPos, selLocalEnd),
                        lineStartOffset + afterCursorPos,
                        { inverse: true },
                      )}
                    </React.Fragment>,
                  );
                }
                pos = selLocalEnd;
              } else {
                // Cursor not on this selection portion — render entire selection inverse
                segments.push(
                  <React.Fragment key="sel">
                    {renderSegment(line.slice(pos, selLocalEnd), lineStartOffset + pos, {
                      inverse: true,
                    })}
                  </React.Fragment>,
                );
                pos = selLocalEnd;
              }

              // Cursor after selection on this line
              if (showCursor && col >= selLocalEnd) {
                // Text between selection end and cursor
                if (col > pos) {
                  segments.push(
                    <React.Fragment key="mid">
                      {renderSegment(line.slice(pos, col), lineStartOffset + pos)}
                    </React.Fragment>,
                  );
                }
                const cursorChar = col < line.length ? line[col] : " ";
                const cursorAbs = lineStartOffset + col;
                const curInCmd = isCommand && cursorAbs < commandEndIndex;
                segments.push(
                  <Text
                    key="cursor"
                    color={theme.commandColor}
                    bold={curInCmd}
                    inverse={cursorVisible}
                    backgroundColor={backgroundColor}
                  >
                    {cursorChar}
                  </Text>,
                );
                pos = col + (col < line.length ? 1 : 0);
              }

              // Text after selection (and cursor)
              if (pos < line.length) {
                segments.push(
                  <React.Fragment key="post">
                    {renderSegment(line.slice(pos), lineStartOffset + pos)}
                  </React.Fragment>,
                );
              }
            } else {
              // No selection on this line — original cursor-only rendering
              const before = showCursor ? line.slice(0, col) : line;
              const charUnderCursor = showCursor ? (col < line.length ? line[col] : " ") : "";
              const after = showCursor ? line.slice(col + (col < line.length ? 1 : 0)) : "";
              const cursorCharOffset = lineStartOffset + col;
              const cursorInCommand = isCommand && cursorCharOffset < commandEndIndex;

              segments.push(
                <React.Fragment key="before">
                  {renderSegment(before, lineStartOffset)}
                </React.Fragment>,
              );
              if (showCursor) {
                segments.push(
                  <Text
                    key="cursor"
                    color={theme.commandColor}
                    bold={cursorInCommand}
                    inverse={cursorVisible}
                    backgroundColor={backgroundColor}
                  >
                    {charUnderCursor}
                  </Text>,
                );
              }
              if (after) {
                segments.push(
                  <React.Fragment key="after">
                    {renderSegment(after, lineStartOffset + col + (col < line.length ? 1 : 0))}
                  </React.Fragment>,
                );
              }
            }

            return (
              <Box key={i} backgroundColor={backgroundColor} width="100%">
                {renderPromptPrefix(i === 0 ? PROMPT : "  ")}
                {segments}
              </Box>
            );
          });
        })()}
      </Box>
      {renderInputEdge(backgroundColor ? INPUT_BOTTOM_FILL : "─")}
      {taskPickerOpen ? (
        <Box paddingRight={2}>
          <TaskPickerMenu
            tasks={tasks}
            selectedIndex={taskPickerIndex}
            width={Math.max(20, columns)}
          />
        </Box>
      ) : isSlashMode && filteredCommands.length > 0 ? (
        <Box paddingRight={2}>
          <SlashCommandMenu
            commands={filteredCommands}
            selectedIndex={menuIndex}
            width={Math.max(20, columns)}
          />
        </Box>
      ) : null}
    </Box>
  );
}
