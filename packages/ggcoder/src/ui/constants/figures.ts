/**
 * Centralized Unicode symbols used across the TUI.
 *
 * Platform-specific characters are detected at import time so every
 * consumer gets the correct glyph without duplicating the check.
 */

const isMac = process.platform === "darwin";

/** Status dot — ⏺ on macOS, ● elsewhere. */
export const BLACK_CIRCLE = isMac ? "\u23FA" : "\u25CF";

/** Tool result bracket — ⎿ (U+23BF). */
export const RETURN_SYMBOL = "\u23BF";

/** Light shade block — ░ (U+2591). */
export const LIGHT_SHADE = "\u2591";

/** Down arrow — ↓ for token flow. */
export const DOWN_ARROW = "\u2193";

/**
 * Partial block characters for gauge bars, from empty (index 0) to full
 * (index 8).  Moved here from Footer.tsx for reuse.
 *
 * Index:  0=" "  1=▏  2=▎  3=▍  4=▌  5=▋  6=▊  7=▉  8=█
 */
export const PARTIAL_BLOCKS = [
  " ",
  "\u258F",
  "\u258E",
  "\u258D",
  "\u258C",
  "\u258B",
  "\u258A",
  "\u2589",
  "\u2588",
];
