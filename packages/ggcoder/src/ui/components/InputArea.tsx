import React, { useState, useRef, useEffect, useMemo } from "react";
import { Text, Box, useInput, useStdout } from "ink";
import { useTheme } from "../theme/theme.js";
import type { ImageAttachment } from "../../utils/image.js";
import { extractImagePaths, readImageFile, getClipboardImage } from "../../utils/image.js";
import { SlashCommandMenu, filterCommands, type SlashCommandInfo } from "./SlashCommandMenu.js";

const MAX_VISIBLE_LINES = 5;
const PROMPT = "❯ ";

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
  cwd: string;
  commands?: SlashCommandInfo[];
}

// Border (1 each side) + padding (1 each side) = 4 characters of overhead
const BOX_OVERHEAD = 4;

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
  const contentWidth = columns - PROMPT.length - BOX_OVERHEAD;
  if (contentWidth <= 0) return [text];
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
  cwd,
  commands = [],
}: InputAreaProps) {
  const theme = useTheme();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const lastEscRef = useRef(0);
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
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
  const [borderFrame, setBorderFrame] = useState(0);
  useEffect(() => {
    if (disabled) return;
    const timer = setInterval(() => {
      setBorderFrame((f) => (f + 1) % borderPulseColors.length);
    }, 800);
    return () => clearInterval(timer);
  }, [disabled, borderPulseColors]);

  // Cursor blink — always active so user can type while agent is busy
  const [cursorVisible, setCursorVisible] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);
    return () => clearInterval(timer);
  }, []);

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

  useInput(
    (input, key) => {
      // Shift+` (tilde) toggles task overlay — works even while agent is running
      if (input === "~" && key.shift) {
        onToggleTasks?.();
        return;
      }

      if (disabled) {
        if ((key.ctrl && input === "c") || key.escape) {
          onAbort();
          return;
        }
        // When disabled (agent running), allow typing but block submission
        if (key.return) return;
      }

      if (key.return && (key.shift || key.meta)) {
        setValue((v) => v.slice(0, cursor) + "\n" + v.slice(cursor));
        setCursor((c) => c + 1);
        return;
      }

      if (key.return) {
        // If slash menu is open and a command is selected, fill it in
        if (isSlashMode && filteredCommands.length > 0) {
          const selected = filteredCommands[Math.min(menuIndex, filteredCommands.length - 1)];
          const cmd = "/" + selected.name;
          // Submit the command directly
          historyRef.current.push(cmd);
          historyIndexRef.current = -1;
          onSubmit(cmd, []);
          setValue("");
          setCursor(0);
          setImages([]);
          setPasteText("");
          return;
        }

        const trimmed = value.trim();
        if (trimmed || images.length > 0) {
          if (trimmed) historyRef.current.push(trimmed);
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
          setValue("");
          setCursor(0);
          setImages([]);
          setPasteText("");
        }
        return;
      }

      // Ctrl+I — paste image from clipboard
      if (key.ctrl && input === "i") {
        getClipboardImage().then((img) => {
          if (img) setImages((prev) => [...prev, img]);
        });
        return;
      }

      if (key.ctrl && input === "c") {
        if (value || images.length > 0) {
          setValue("");
          setCursor(0);
          setImages([]);
          setPasteText("");
        } else {
          onAbort();
        }
        return;
      }

      if (key.ctrl && input === "d") {
        process.exit(0);
      }

      // Home / End
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }

      // Ctrl+U / Ctrl+W — delete word backward (Cmd+Backspace / Option+Backspace on macOS)
      if (key.ctrl && (input === "u" || input === "w")) {
        const before = value.slice(0, cursor);
        const trimmed = before.replace(/\s+$/, "");
        const lastSpace = trimmed.lastIndexOf(" ");
        const newCursor = lastSpace === -1 ? 0 : lastSpace + 1;
        setValue((v) => v.slice(0, newCursor) + v.slice(cursor));
        setCursor(newCursor);
        return;
      }

      // Ctrl+K — delete from cursor to end of line
      if (key.ctrl && input === "k") {
        setValue((v) => v.slice(0, cursor));
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
          setCursor((c) => c - 1);
        } else if (!value && images.length > 0) {
          setImages((prev) => prev.slice(0, -1));
        }
        return;
      }

      if (key.upArrow) {
        // If slash menu is open, navigate it
        if (isSlashMode && filteredCommands.length > 0) {
          setMenuIndex((i) => Math.max(0, i - 1));
          return;
        }
        const history = historyRef.current;
        if (history.length === 0) return;
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
        const history = historyRef.current;
        if (historyIndexRef.current === -1) {
          if (onDownAtEnd) onDownAtEnd();
          return;
        }
        const newIndex = historyIndexRef.current + 1;
        if (newIndex >= history.length) {
          historyIndexRef.current = -1;
          setValue("");
          setCursor(0);
        } else {
          historyIndexRef.current = newIndex;
          setValue(history[newIndex]);
          setCursor(history[newIndex].length);
        }
        return;
      }

      if (key.escape) {
        const now = Date.now();
        if ((value || images.length > 0) && now - lastEscRef.current < 400) {
          setValue("");
          setCursor(0);
          setImages([]);
          setPasteText("");
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
        }
        return;
      }

      if (key.leftArrow) {
        if (cursor > 0) setCursor((c) => c - 1);
        return;
      }

      if (key.rightArrow) {
        if (cursor < value.length) setCursor((c) => c + 1);
        return;
      }

      if (input) {
        const normalized = input.replace(/\r\n?/g, "\n");
        setValue((v) => v.slice(0, cursor) + normalized + v.slice(cursor));
        setCursor((c) => c + normalized.length);

        // Detect paste: Ink delivers pasted text as input.length > 1
        // For large pastes, Ink may split into multiple chunks, so we
        // accumulate and debounce to capture the full paste.
        if (input.length > 1) {
          setPasteText((prev) => {
            if (!prev) setPasteOffset(cursor); // record where paste starts on first chunk
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
  const contentWidth = columns - PROMPT.length - BOX_OVERHEAD;

  // Find which visual line and column the cursor is on
  const cursorLineInfo = useMemo(() => {
    let pos = 0;
    const hardLines = value.split("\n");
    let visualLineIndex = 0;
    for (let h = 0; h < hardLines.length; h++) {
      const wrapped = wrapLine(hardLines[h], contentWidth > 0 ? contentWidth : value.length + 1);
      for (let w = 0; w < wrapped.length; w++) {
        const lineLen = wrapped[w].length;
        const lineStart = pos;
        const lineEnd = pos + lineLen;
        // Cursor is on this visual line if it falls within [lineStart, lineEnd]
        // For the last wrapped segment of a hard line, also include the newline position
        const isLastWrap = w === wrapped.length - 1;
        const effectiveEnd = isLastWrap ? lineEnd : lineEnd;
        if (cursor >= lineStart && cursor <= effectiveEnd) {
          return { line: visualLineIndex, col: cursor - lineStart };
        }
        pos += lineLen;
        // Account for the space consumed by word-wrap break
        if (!isLastWrap) {
          // wrapped lines don't consume extra chars unless word-broken
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

  // Determine if the input starts with a slash command and find command boundary
  const isCommand = value.startsWith("/");
  // Command portion ends at first space (e.g., "/research" in "/research some args")
  const commandEndIndex = isCommand
    ? value.indexOf(" ") === -1
      ? value.length
      : value.indexOf(" ")
    : 0;

  return (
    <Box flexDirection="column">
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
                <Text color={disabled ? theme.textDim : theme.inputPrompt} bold>
                  {PROMPT}
                </Text>
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
            for (let j = 0; j < startLine + i; j++) {
              lineStartOffset += visualLines[j].length;
            }
            const hardLines = value.split("\n");
            let offset = 0;
            let vlIndex = 0;
            for (let h = 0; h < hardLines.length && vlIndex <= startLine + i; h++) {
              const wrapped = wrapLine(
                hardLines[h],
                contentWidth > 0 ? contentWidth : value.length + 1,
              );
              for (let w = 0; w < wrapped.length && vlIndex <= startLine + i; w++) {
                if (vlIndex === startLine + i) {
                  lineStartOffset = offset;
                }
                offset += wrapped[w].length;
                vlIndex++;
              }
              offset++; // newline
            }

            // Determine color for each character based on whether it's in the command portion
            const renderSegments = (text: string, textStartOffset: number) => {
              if (!isCommand || textStartOffset >= commandEndIndex) {
                return <Text color={theme.text}>{text}</Text>;
              }
              const cmdChars = Math.min(text.length, commandEndIndex - textStartOffset);
              if (cmdChars >= text.length) {
                return (
                  <Text color={theme.commandColor} bold>
                    {text}
                  </Text>
                );
              }
              return (
                <>
                  <Text color={theme.commandColor} bold>
                    {text.slice(0, cmdChars)}
                  </Text>
                  <Text color={theme.text}>{text.slice(cmdChars)}</Text>
                </>
              );
            };

            const before = showCursor ? line.slice(0, col) : line;
            const charUnderCursor = showCursor ? (col < line.length ? line[col] : " ") : "";
            const after = showCursor ? line.slice(col + (col < line.length ? 1 : 0)) : "";
            const cursorCharOffset = lineStartOffset + col;
            const cursorInCommand = isCommand && cursorCharOffset < commandEndIndex;

            return (
              <Box key={i}>
                <Text color={disabled ? theme.textDim : theme.inputPrompt} bold>
                  {i === 0 ? PROMPT : "  "}
                </Text>
                {renderSegments(before, lineStartOffset)}
                {showCursor && (
                  <Text
                    color={cursorInCommand ? theme.commandColor : theme.text}
                    bold={cursorInCommand}
                    inverse={cursorVisible}
                  >
                    {charUnderCursor}
                  </Text>
                )}
                {after &&
                  renderSegments(after, lineStartOffset + col + (col < line.length ? 1 : 0))}
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
