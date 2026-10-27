// Maps a sub-agent's latest tool activity string to the kind of work its
// critter acts out on the floor. Activity arrives in two shapes:
//
//  1. Humanized (packages/ggcoder/src/tools/subagent.ts formatToolActivity):
//     "Reading src/a.ts", "Searching for \"foo\"", "Running pnpm test", …,
//     or "<name>: <detail>" / "<name>" for anything it doesn't special-case.
//  2. Raw (packages/ggcoder/src/core/subagent-manager.ts activity()):
//     "<toolname>: <first string arg>" or "<toolname>".
//
// Waiting on / stopping a background task ("Reading task output …",
// "Stopping task …", task_output, task_stop) is bookkeeping rather than work
// the critter can act out, so it maps to null and the critter carries on with
// whatever it was doing.

export type ToolKind = "read" | "search" | "edit" | "run" | "web";

/** Humanized prefixes, most specific first ("Searching web for" before "Searching for"). */
const PREFIXES: readonly (readonly [string, ToolKind | null])[] = [
  ["Reading task output", null],
  ["Stopping task", null],
  ["Searching web for", "web"],
  ["Searching for", "search"],
  ["Finding", "search"],
  ["Resolving source for", "search"],
  ["Reading", "read"],
  ["Listing", "read"],
  ["Loading skill", "read"],
  ["Writing", "edit"],
  ["Editing", "edit"],
  ["Running", "run"],
  ["Fetching", "web"],
];

/** Raw tool names. Anything not listed (MCP tools, sub-agents…) is null. */
const TOOL_NAMES: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
  ["read", "read"],
  ["ls", "read"],
  ["skill", "read"],
  ["grep", "search"],
  ["find", "search"],
  ["source_path", "search"],
  ["edit", "edit"],
  ["write", "edit"],
  ["bash", "run"],
  ["debug", "run"],
  ["web_fetch", "web"],
  ["web_search", "web"],
]);

/** A bare tool name, optionally followed by ": detail". */
const NAMED = /^([A-Za-z_][\w.-]*)(?::|$)/;

/** The kind of work an activity string describes, or null when it's not one we act out. */
export function toolKindOf(activity: string | undefined): ToolKind | null {
  const text = activity?.trim();
  if (!text) return null;
  for (const [prefix, kind] of PREFIXES) {
    if (text === prefix || text.startsWith(`${prefix} `)) return kind;
  }
  const name = NAMED.exec(text)?.[1]?.toLowerCase();
  if (!name) return null;
  return TOOL_NAMES.get(name) ?? null;
}
