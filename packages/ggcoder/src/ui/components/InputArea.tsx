import React, { useState, useRef, useEffect, useMemo } from "react";
import { Text, Box, useInput, useStdin } from "ink";
import type { EventEmitter } from "events";
import { useTheme } from "../theme/theme.js";
import { useAnimationTick, useAnimationActive, deriveFrame } from "./AnimationContext.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import type { ImageAttachment } from "../../utils/image.js";
import { extractImagePaths, readImageFile, getClipboardImage } from "../../utils/image.js";
import { SlashCommandMenu, filterCommands, type SlashCommandInfo } from "./SlashCommandMenu.js";
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

const MAX_VISIBLE_LINES = 5;
const PROMPT = "❯ ";

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
  disabled?: boolean;
  isActive?: boolean;
  onDownAtEnd?: () => void;
  onShiftTab?: () => void;
  onToggleTasks?: () => void;
  onToggleSkills?: () => void;
  onTogglePlanMode?: () => void;
  cwd: string;
  commands?: SlashCommandInfo[];
}

// Border (1 each side) + padding (1 each side) = 4 characters of overhead
const BOX_OVERHEAD = 4;
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
  const contentWidth = Math.max(MIN_CONTENT_WIDTH, columns - PROMPT.length - BOX_OVERHEAD);
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
  disabled = false,
  isActive = true,
  onDownAtEnd,
  onShiftTab,
  onToggleTasks,
  onToggleSkills,
  onTogglePlanMode,
  cwd,
  commands = [],
}: InputAreaProps) {
  const theme = useTheme();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const historyRef = useRef<string[]>(loadHistory());
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");

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

  // Reset menu index when filter changes
  useEffect(() => {
    setMenuIndex(0);
  }, [slashFilter]);

  // Border color pulse (when idle/waiting for input)
  const borderPulseColors = useMemo(
    () => [theme.primary, theme.accent, theme.secondary, theme.accent],
    [theme.primary, theme.accent, theme.secondary],
  );

  // Derive border pulse and cursor blink from global animation tick
  useAnimationActive();
  const tick = useAnimationTick();
  const borderFrame = disabled ? 0 : deriveFrame(tick, 800, borderPulseColors.length);
  // Cursor blink: ~530ms period → visible for ~500ms, hidden for ~500ms
  const cursorVisible = !isActive || deriveFrame(tick, 530, 2) === 0;

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

  // Normalize numpad Enter (kpenter) to regular Enter.  With the kitty
  // keyboard protocol enabled, numpad Enter sends codepoint 57414 which Ink
  // parses as "kpenter" instead of "return", so key.return is never set.
  // We listen on Ink's internal event emitter and re-emit the sequence as
  // a plain carriage return (\r) that Ink recognises as key.return.
  const { internal_eventEmitter } = useStdin() as ReturnType<typeof useStdin> & {
    internal_eventEmitter: EventEmitter;
  };
  useEffect(() => {
    if (!isActive || !internal_eventEmitter) return;
    // Matches ESC[57414u  or  ESC[57414;Nu  (N = modifier) — numpad Enter
    // in the kitty keyboard protocol.
    // eslint-disable-next-line no-control-regex
    const kpEnterRe = /^\x1b\[57414(;\d+)?u$/;
    const onInput = (data: string): void => {
      if (kpEnterRe.test(data)) {
        // Determine modifier flags from the sequence
        const modMatch = /;(\d+)u$/.exec(data);
        const mod = modMatch ? Math.max(0, parseInt(modMatch[1], 10) - 1) : 0;
        const hasShift = !!(mod & 1);
        const hasMeta = !!(mod & 10);
        // Re-emit as regular Enter, preserving shift/meta for newline insertion
        const synth = hasShift ? "\x1b[13;2u" : hasMeta ? "\x1b\r" : "\r";
        internal_eventEmitter.emit("input", synth);
      }
    };
    internal_eventEmitter.on("input", onInput);
    return () => {
      internal_eventEmitter.removeListener("input", onInput);
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

  useEffect(() => {
    if (!isActive || !internal_eventEmitter) return;

    // Only enable mouse tracking if there's text — when empty, let the
    // terminal handle clicks natively (e.g., CMD+click to open links).
    if (hasInputTextRef.current) {
      process.stdout.write(ENABLE_MOUSE);
    }

    // Safety: ensure mouse tracking is disabled even on crash/SIGINT/unexpected exit
    // so the terminal isn't left in a broken state sending escape sequences on every click.
    const onProcessExit = () => process.stdout.write(DISABLE_MOUSE);
    process.on("exit", onProcessExit);

    const originalEmit = internal_eventEmitter.emit.bind(internal_eventEmitter);
    mouseEmitRef.current.original = originalEmit;

    // Scroll passthrough: when a scroll event is detected, temporarily disable
    // mouse tracking so the terminal handles scroll natively (scrollback buffer).
    // Re-enable after a short idle period so click-to-cursor continues to work.
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    let mouseDisabled = false;

    const reenableMouse = () => {
      if (mouseDisabled && hasInputTextRef.current) {
        process.stdout.write(ENABLE_MOUSE);
        mouseDisabled = false;
      }
    };

    const pauseMouseForScroll = () => {
      if (!mouseDisabled) {
        process.stdout.write(DISABLE_MOUSE);
        mouseDisabled = true;
      }
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(reenableMouse, 300);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    internal_eventEmitter.emit = (event: string | symbol, ...args: any[]): boolean => {
      if (event === "input" && typeof args[0] === "string") {
        const data = args[0] as string;
        // Strip all SGR mouse sequences from the data
        const stripped = data.replace(SGR_MOUSE_RE_G, "");

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

          // On scroll: disable mouse tracking so the terminal handles it natively,
          // then re-enable after idle so click-to-cursor keeps working.
          if (isScroll) {
            pauseMouseForScroll();
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
    const hasText = value.length > 0;
    if (hasText !== hasInputTextRef.current) {
      hasInputTextRef.current = hasText;
      if (isActive) {
        process.stdout.write(hasText ? ENABLE_MOUSE : DISABLE_MOUSE);
      }
    }
  }, [value, isActive]);

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
      if (isMouseEscapeSequence(input)) return;

      // Reset kill ring accumulation for non-kill keys
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
        if (key.return) {
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

      // Ctrl+T toggles task overlay — works even while agent is running
      if (key.ctrl && input === "t") {
        onToggleTasks?.();
        return;
      }

      // Ctrl+S toggles skills overlay
      if (key.ctrl && input === "s") {
        onToggleSkills?.();
        return;
      }

      // Ctrl+P toggles plan mode
      if (key.ctrl && input === "p") {
        onTogglePlanMode?.();
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

      if (key.return && (key.shift || key.meta)) {
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

      if (key.return) {
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
        }
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
  const contentWidth = Math.max(MIN_CONTENT_WIDTH, columns - PROMPT.length - BOX_OVERHEAD);

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

  return (
    <Box flexDirection="column" width={columns}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={disabled ? theme.textDim : borderPulseColors[borderFrame]}
        paddingLeft={1}
        paddingRight={1}
      >
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
              <Box>
                {searchMode ? (
                  <Text color={searchFailed ? theme.error : theme.inputPrompt} bold>
                    {searchFailed ? "(fail)" : "(i-search)"}
                    {`'${searchQuery}': `}
                  </Text>
                ) : (
                  <Text color={disabled ? theme.textDim : theme.inputPrompt} bold>
                    {PROMPT}
                  </Text>
                )}
                <Text color={theme.text}>{displayStr.slice(0, cursorInDisplay)}</Text>
                <Text color={theme.text} inverse={cursorVisible}>
                  {cursorInDisplay < displayStr.length ? displayStr[cursorInDisplay] : " "}
                </Text>
                {cursorInDisplay + 1 < displayStr.length && (
                  <Text color={theme.text}>{displayStr.slice(cursorInDisplay + 1)}</Text>
                )}
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
                  <Text color={theme.commandColor} bold inverse={inv}>
                    {text}
                  </Text>
                );
              }
              if (cmdChars > 0) {
                return (
                  <>
                    <Text color={theme.commandColor} bold inverse={inv}>
                      {text.slice(0, cmdChars)}
                    </Text>
                    <Text color={theme.text} inverse={inv}>
                      {text.slice(cmdChars)}
                    </Text>
                  </>
                );
              }
              return (
                <Text color={theme.text} inverse={inv}>
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
                    color={curInCmd ? theme.commandColor : theme.text}
                    bold={curInCmd}
                    inverse={cursorVisible}
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
                    color={curInCmd ? theme.commandColor : theme.text}
                    bold={curInCmd}
                    inverse={cursorVisible}
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
                    color={cursorInCommand ? theme.commandColor : theme.text}
                    bold={cursorInCommand}
                    inverse={cursorVisible}
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
              <Box key={i}>
                <Text color={disabled ? theme.textDim : theme.inputPrompt} bold>
                  {i === 0 ? PROMPT : "  "}
                </Text>
                {segments}
              </Box>
            );
          });
        })()}
      </Box>
      {/* Slash command menu — shown below the input box */}
      {isSlashMode && filteredCommands.length > 0 && (
        <SlashCommandMenu commands={commands} filter={slashFilter} selectedIndex={menuIndex} />
      )}
    </Box>
  );
}
