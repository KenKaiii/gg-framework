// ── GG Royale "bug fixed" classifier ────────────────────────────────────
// Pure: given one run's transcript slice, decide whether a check-like shell
// command (tests/build/typecheck/lint) failed and a later run of the SAME
// command passed, and label the FAILED output with one coarse category.
// Only the category label ever leaves the machine — never the command,
// output, or paths.

export const ROYALE_BUG_CATEGORIES = [
  "type",
  "null",
  "test",
  "build",
  "lint",
  "syntax",
  "timeout",
  "crash",
] as const;

export type RoyaleBugCategory = (typeof ROYALE_BUG_CATEGORIES)[number];

interface PartLike {
  type: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  toolCallId?: string;
  content?: unknown;
  isError?: boolean;
}

export interface MessageLike {
  role: string;
  content: string | ReadonlyArray<PartLike>;
}

const SHELL_TOOLS = new Set(["bash", "shell"]);

const CHECK_RE =
  /\b(test|tests|vitest|jest|pytest|mocha|tsc|typecheck|build|lint|eslint|biome|ruff|clippy|mypy|pyright|check)\b/i;

/** Ordered: first match wins (more specific before generic "test"/"build"). */
const RULES: ReadonlyArray<readonly [RoyaleBugCategory, RegExp]> = [
  ["timeout", /\btim(e|ed)[ -]?out\b|\btimeout\b/i],
  [
    "crash",
    /\bpanic(ked)?\b|segfault|segmentation fault|core dumped|\bcrash(ed)?\b|uncaught exception/i,
  ],
  ["syntax", /SyntaxError|unexpected token|parse error|parsing error/i],
  [
    "null",
    /Cannot read propert(y|ies) of (undefined|null)|\bis (undefined|null)\b|NoneType|nil pointer|NullPointerException|null pointer/i,
  ],
  ["type", /TypeError|type error|error TS\d{4}|\bTS2\d{3}\b|is not assignable to type/i],
  ["lint", /\blint\b|eslint|ruff|clippy|biome/i],
  ["test", /AssertionError|assert(ion)?|\bexpected\b|tests? failed|\bFAIL\b|failing/i],
  [
    "build",
    /build failed|compil(e|ation|er) (error|failed)|failed to compile|bundl|\berror\[E\d+\]/i,
  ],
];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: unknown) =>
      typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string"
        ? (c as { text: string }).text
        : "",
    )
    .join("\n");
}

/** Bash results begin "Exit code: N" (or TIMEOUT…). Unknown → null. */
function exitOk(result: string, isError: boolean | undefined): boolean | null {
  const m = /^Exit code: (\S+)/.exec(result);
  if (m) return m[1] === "0";
  return isError === true ? false : null;
}

function normalize(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

export function categorizeFailure(output: string, command: string): RoyaleBugCategory {
  for (const [cat, re] of RULES) if (re.test(output)) return cat;
  // Fall back to what kind of check it was.
  if (/\b(tsc|typecheck|mypy|pyright)\b/i.test(command)) return "type";
  if (/\b(lint|eslint|ruff|clippy|biome)\b/i.test(command)) return "lint";
  if (/\bbuild\b/i.test(command)) return "build";
  return "test";
}

/** Category of the first check that failed then later passed, or null. */
export function classifyFixedCheck(messages: ReadonlyArray<MessageLike>): RoyaleBugCategory | null {
  const commands = new Map<string, string>();
  const runs: { command: string; ok: boolean; output: string }[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const part of m.content) {
      if (m.role === "assistant" && part.type === "tool_call" && part.id && part.name) {
        const cmd = part.args?.command;
        if (SHELL_TOOLS.has(part.name) && typeof cmd === "string" && CHECK_RE.test(cmd)) {
          commands.set(part.id, normalize(cmd));
        }
      } else if (m.role === "tool" && part.type === "tool_result" && part.toolCallId) {
        const command = commands.get(part.toolCallId);
        if (command === undefined) continue;
        const output = textOf(part.content);
        const ok = exitOk(output, part.isError);
        if (ok !== null) runs.push({ command, ok, output });
      }
    }
  }
  const failed = new Map<string, string>();
  for (const r of runs) {
    if (!r.ok) {
      if (!failed.has(r.command)) failed.set(r.command, r.output);
    } else {
      const out = failed.get(r.command);
      if (out !== undefined) return categorizeFailure(out, r.command);
    }
  }
  return null;
}
