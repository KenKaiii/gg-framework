import type { ThinkingLevel } from "@kleio/ai";

const THINKING_LEVELS = new Set<ThinkingLevel>(["low", "medium", "high", "xhigh", "max", "ultra"]);

/**
 * Parses the `--thinking` flag. Shared by cli.ts and app-sidecar.ts: both are
 * JSON-mode entry points the subagent spawner may run, so both must accept it.
 */
export function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (THINKING_LEVELS.has(value as ThinkingLevel)) return value as ThinkingLevel;
  throw new Error(
    `Invalid --thinking value "${value}". Expected low, medium, high, xhigh, max, or ultra.`,
  );
}
