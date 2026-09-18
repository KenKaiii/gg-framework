// Automatic per-project accent identity. Personal overrides live separately in
// project-colours.ts; this palette and hash remain the unconfigured default.

/**
 * Accent palette. Hand-picked rather than generated: an evenly spaced hue wheel
 * produces muddy olives and dead navies at this lightness. Every entry sits in
 * the same OKLCH lightness band as the existing `theme.primary` family (L 69–76)
 * so an accent never out-shouts the UI or drops below contrast on `--bg`.
 */
export const PROJECT_ACCENTS = [
  "#4d9dff", // blue
  "#9b8cf7", // violet
  "#36c489", // green
  "#e3a23f", // amber
  "#f2716e", // coral
  "#2dd4bf", // teal
  "#f472b6", // pink
  "#a3b83f", // lime
  "#5ad1e6", // cyan
  "#c98bff", // orchid
] as const;

export const PROJECT_COLOUR_NAMES = [
  "Blue",
  "Violet",
  "Green",
  "Amber",
  "Coral",
  "Teal",
  "Pink",
  "Lime",
  "Cyan",
  "Orchid",
] as const;

export type ProjectColour = (typeof PROJECT_COLOUR_NAMES)[number];
export type ProjectColourChoice = ProjectColour | "Automatic" | "None";

export function isProjectColourChoice(value: unknown): value is ProjectColourChoice {
  return (
    value === "Automatic" || value === "None" || PROJECT_COLOUR_NAMES.some((name) => name === value)
  );
}

/** Only palette values can reach CSS, never raw persisted strings. */
export function resolveProjectAccent(
  cwd: string | null | undefined,
  choice: ProjectColourChoice = "Automatic",
): string | null {
  const automatic = projectAccent(cwd);
  if (!automatic || choice === "None") return null;
  const index = PROJECT_COLOUR_NAMES.findIndex((name) => name === choice);
  return index < 0 ? automatic : PROJECT_ACCENTS[index];
}

/**
 * FNV-1a (32-bit). Chosen over a hand-rolled `hash * 31 + c` because it
 * avalanches properly on short, highly-similar ASCII strings — which is exactly
 * what sibling project paths are (`.../gg-coder`, `.../gg-boss`). Weak hashes
 * hand those neighbours the same bucket, defeating the whole point.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // 32-bit FNV prime (16777619) via shifts — `*` would lose precision above 2^53.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The accent for a project directory. Keyed on the FINAL path segment, not the
 * whole path, so the same project keeps its colour after a move — and so two
 * checkouts of the same repo read as the same thing.
 *
 * Returns `null` for no project (Home, or a chat window with no folder), where
 * the caller should fall back to the default chrome.
 */
export function projectAccent(cwd: string | null | undefined): string | null {
  const name = cwd?.split(/[\\/]/).filter(Boolean).pop();
  if (!name) return null;
  return PROJECT_ACCENTS[fnv1a(name.toLowerCase()) % PROJECT_ACCENTS.length];
}
