import type { Theme } from "../theme/theme.js";

export type ToolTone =
  | "read"
  | "search"
  | "write"
  | "run"
  | "web"
  | "agent"
  | "state"
  | "source"
  | "default";

export interface ToolPalette {
  primary: string;
  accent: string;
  detail: string;
}

export function getToolTone(name: string): ToolTone {
  if (["read", "ls"].includes(name)) return "read";
  if (["grep", "find", "mcp__kencode-search__searchCode"].includes(name)) return "search";
  if (["write", "edit"].includes(name)) return "write";
  if (["bash", "task_output", "task_stop"].includes(name)) return "run";
  if (
    [
      "web_fetch",
      "web_search",
      "mcp__kencode-search__referenceSources",
      "mcp__kencode-search__discoverRepos",
    ].includes(name)
  )
    return "web";
  if (["subagent", "skill"].includes(name)) return "agent";
  if (["tasks"].includes(name)) return "state";
  if (["source_path"].includes(name)) return "source";
  if (name.startsWith("mcp__")) return "web";
  return "default";
}

export function toolTonePalette(theme: Theme, tone: ToolTone): ToolPalette {
  switch (tone) {
    case "read":
      return { primary: theme.toolName, accent: theme.accent, detail: theme.textDim };
    case "search":
      return { primary: theme.accent, accent: theme.secondary, detail: theme.textDim };
    case "write":
      return { primary: theme.toolSuccess, accent: theme.language, detail: theme.textDim };
    case "run":
      return { primary: theme.code, accent: theme.warning, detail: theme.textDim };
    case "web":
      return { primary: theme.language, accent: theme.link, detail: theme.textDim };
    case "agent":
      return { primary: theme.primary, accent: theme.accent, detail: theme.textDim };
    case "state":
      return { primary: theme.commandColor, accent: theme.accent, detail: theme.textDim };
    case "source":
      return { primary: theme.secondary, accent: theme.toolName, detail: theme.textDim };
    case "default":
      return { primary: theme.toolName, accent: theme.accent, detail: theme.textDim };
  }
}

export function toolNameColor(theme: Theme, name: string): string {
  return toolTonePalette(theme, getToolTone(name)).primary;
}

export function toolAccentColor(theme: Theme, name: string): string {
  return toolTonePalette(theme, getToolTone(name)).accent;
}
