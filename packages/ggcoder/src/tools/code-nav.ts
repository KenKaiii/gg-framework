import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import type { LspManager, LspNavigationOutcome } from "../core/lsp/manager.js";
import type { LspLocation, LspSymbolEntry } from "../core/lsp/client.js";
import { resolvePath, toPosixPath } from "./path-utils.js";
import { localOperations, type ToolOperations } from "./operations.js";

const CodeNavParams = z.object({
  op: z
    .enum(["definition", "references", "symbols", "hover"])
    .describe("symbols = file outline; hover = type/signature"),
  file: z.string(),
  line: z.number().int().min(1).optional().describe("Not needed when `symbol` is given"),
  column: z.number().int().min(1).optional(),
  symbol: z.string().optional().describe("Symbol name"),
  max_results: z.number().int().min(1).optional().describe("Default 60"),
});

const DEFAULT_MAX_RESULTS = 60;
const MAX_SNIPPET_LENGTH = 160;
const MAX_HOVER_LENGTH = 1200;

/**
 * LSP SymbolKind, for the outline. Numbers are the wire values; the names are
 * what a reader of the tool output actually wants to see.
 */
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

/**
 * Semantic code navigation, backed by the project's language server.
 *
 * One tool with an `op` enum rather than four tools: each tool in the live set
 * costs a full JSON schema on every request, and four near-identical schemas
 * would spend the budget this harness is trying to save.
 *
 * Rename is deliberately absent. A workspace-wide rename that half-applies is
 * worse than no rename at all, and nothing here can roll one back.
 */
export function createCodeNavTool(
  cwd: string,
  lspManager: LspManager | undefined,
  ops: ToolOperations = localOperations,
): AgentTool<typeof CodeNavParams> {
  return {
    name: "code_nav",
    description: "Language server: exact definition, references (callers), file outline, type.",
    parameters: CodeNavParams,
    async execute({ op, file, line, column, symbol, max_results }) {
      if (!lspManager) {
        return "code_nav is unavailable: language-server support is disabled for this session. Use grep or code_search instead.";
      }
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      const absolute = resolvePath(cwd, file);

      let content: string;
      try {
        content = await ops.readFile(absolute);
      } catch (error) {
        return `Cannot read ${toPosixPath(path.relative(cwd, absolute))}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      const lines = content.split("\n");

      if (op === "symbols") {
        const outcome = await lspManager.documentSymbols(absolute, content);
        if (outcome.kind !== "ok") return describeFailure(outcome, cwd, op);
        return formatSymbols(outcome.value, symbol, maxResults);
      }

      const position = resolvePosition(lines, line, column, symbol);
      if (typeof position === "string") return position;

      if (op === "hover") {
        const outcome = await lspManager.hover(absolute, content, position);
        if (outcome.kind !== "ok") return describeFailure(outcome, cwd, op);
        const text = outcome.value.trim();
        if (!text) return `No hover information at ${describeSite(cwd, absolute, position)}.`;
        return text.length > MAX_HOVER_LENGTH
          ? `${text.slice(0, MAX_HOVER_LENGTH)}\n… [hover truncated]`
          : text;
      }

      const outcome =
        op === "definition"
          ? await lspManager.definition(absolute, content, position)
          : await lspManager.references(absolute, content, position);
      if (outcome.kind !== "ok") return describeFailure(outcome, cwd, op);
      const locations = await formatLocations(
        outcome.value,
        cwd,
        ops,
        maxResults,
        op,
        absolute,
        position,
      );
      return outcome.warning ? `${outcome.warning}\n\n${locations}` : locations;
    },
  };
}

/**
 * Turn a 1-based line (+ optional column or symbol name) into an LSP position.
 * Returning a string means the request cannot be built at all, which is a
 * clearer answer than sending the server a position that resolves to nothing.
 */
/**
 * First line where `symbol` appears as a whole word, preferring real code.
 *
 * Comment lines are skipped: a doc comment mentioning the name carries no
 * resolvable symbol, so the server answers nothing there and the caller would
 * read that empty reply as "no references". A comment-only hit is still
 * returned as a last resort, which beats claiming the name is absent.
 */
function findSymbolLine(lines: readonly string[], symbol: string): number | undefined {
  const word = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  let commentHit: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!word.test(lines[i])) continue;
    const trimmed = lines[i].trim();
    if (/^(\/\/|\/\*|\*|#)/.test(trimmed)) {
      commentHit ??= i + 1;
      continue;
    }
    return i + 1;
  }
  return commentHit;
}

function resolvePosition(
  lines: string[],
  line: number | undefined,
  column: number | undefined,
  symbol: string | undefined,
): { line: number; character: number } | string {
  if (line === undefined) {
    // You almost always know the NAME and not the line. Requiring both forced a
    // grep round-trip before every single call, so `symbol` alone is enough:
    // any occurrence resolves, since the server walks from a reference to its
    // declaration anyway.
    if (!symbol) {
      return 'Pass `symbol` (its name) or `line` (1-based) so I know what to resolve. op: "symbols" needs neither.';
    }
    const found = findSymbolLine(lines, symbol);
    if (found === undefined) {
      return `\`${symbol}\` does not appear in this file. Check the name, or pass \`line\` directly.`;
    }
    line = found;
  }
  if (line > lines.length) {
    return `Line ${line} is past the end of the file (${lines.length} lines).`;
  }
  const text = lines[line - 1] ?? "";
  if (column !== undefined) return { line: line - 1, character: column - 1 };
  if (symbol) {
    const index = text.indexOf(symbol);
    if (index === -1) {
      return `\`${symbol}\` does not appear on line ${line}. Pass \`column\`, or the line where it does appear.`;
    }
    return { line: line - 1, character: index };
  }
  // No column and no name: aim at the first non-whitespace character, which is
  // the identifier far more often than column 1 is.
  const firstNonSpace = text.search(/\S/);
  return { line: line - 1, character: firstNonSpace === -1 ? 0 : firstNonSpace };
}

function describeSite(
  cwd: string,
  absolute: string,
  position: { line: number; character: number },
): string {
  return `${toPosixPath(path.relative(cwd, absolute))}:${position.line + 1}:${position.character + 1}`;
}

/**
 * Render a non-`ok` outcome as an instruction, not an absence. "No references
 * found" and "no language server installed" are opposite facts, and conflating
 * them makes the model confidently delete live code.
 */
function describeFailure(
  outcome: Exclude<LspNavigationOutcome<unknown>, { kind: "ok" }>,
  cwd: string,
  op: string,
): string {
  const rel = toPosixPath(path.relative(cwd, outcome.filePath)) || outcome.filePath;
  switch (outcome.kind) {
    case "unsupported":
      return outcome.serverId
        ? `The ${outcome.serverId} language server does not implement \`${op}\`. Fall back to code_search or grep.`
        : `No language server is configured for ${rel}. Fall back to code_search or grep.`;
    case "unavailable":
      return `No language server is installed for ${rel}${
        outcome.serverId ? ` (expected: ${outcome.serverId})` : ""
      }. Install it to enable code_nav, or fall back to code_search or grep.`;
    case "timeout":
      return `The language server did not answer \`${op}\` for ${rel} in time. It may still be indexing — retry once, then fall back to grep.`;
    default:
      return `The language server failed on \`${op}\` for ${rel}${
        outcome.message ? `: ${outcome.message}` : ""
      }. Fall back to code_search or grep.`;
  }
}

/**
 * Ancestor kinds that make a nested symbol part of a file's STRUCTURE rather
 * than an implementation detail: a method inside a class belongs in an outline,
 * a `const` inside a function body does not.
 */
const STRUCTURAL_CONTAINER_KINDS = new Set([
  1, // file
  2, // module
  3, // namespace
  4, // package
  5, // class
  10, // enum
  11, // interface
  23, // struct
]);

/**
 * Is this symbol part of the file's outline, or noise from inside a body?
 *
 * Language servers return the FULL symbol tree, so an unfiltered outline buries
 * the eight declarations you wanted under every loop counter, local `const` and
 * nested object-literal key in the file. Measured on a real 300-line source
 * file: 89 symbols, with the truncation limit reached before the last real
 * function was ever printed — the outline actively hid what it exists to show.
 *
 * A symbol survives only when every ancestor is structural. Servers that send
 * flat `SymbolInformation` report no ancestor kinds at all; those pass through,
 * since that shape is already a top-level list.
 */
function isOutlineSymbol(entry: LspSymbolEntry): boolean {
  return entry.containerKinds.every((kind) => STRUCTURAL_CONTAINER_KINDS.has(kind));
}

function formatSymbols(
  symbols: LspSymbolEntry[],
  filter: string | undefined,
  maxResults: number,
): string {
  // Document order, not server order. An outline is read against the file, but
  // tsserver groups its reply by name, so line numbers arrived scrambled
  // (22, 63, 51, 78…) and the outline could not be followed top to bottom.
  const outline = symbols
    .filter(isOutlineSymbol)
    .slice()
    .sort(
      (a, b) =>
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    );
  const matched = filter
    ? outline.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()))
    : outline;
  if (matched.length === 0) {
    return filter ? `No symbol matching \`${filter}\` in this file.` : "No symbols in this file.";
  }
  const shown = matched.slice(0, maxResults);
  const lines = shown.map((entry) => {
    const qualified = [...entry.containers, entry.name].join(".");
    const kind = SYMBOL_KIND_NAMES[entry.kind] ?? "symbol";
    const detail = entry.detail ? ` ${entry.detail}` : "";
    return `${entry.range.start.line + 1}:${entry.range.start.character + 1} — ${kind} ${qualified}${detail}`;
  });
  if (matched.length > shown.length) {
    lines.push(`… ${matched.length - shown.length} more symbol(s) not shown`);
  }
  return lines.join("\n");
}

async function formatLocations(
  locations: LspLocation[],
  cwd: string,
  ops: ToolOperations,
  maxResults: number,
  op: string,
  originFile: string,
  position: { line: number; character: number },
): Promise<string> {
  if (locations.length === 0) {
    return op === "definition"
      ? `No definition found for the symbol at ${describeSite(cwd, originFile, position)}.`
      : `No references found for the symbol at ${describeSite(cwd, originFile, position)}.`;
  }

  const shown = locations.slice(0, maxResults);
  // One read per distinct file, not per location: a hot symbol produces many
  // hits in the same file and re-reading it per hit is the whole cost.
  const sourceCache = new Map<string, string[] | null>();
  const lines: string[] = [];
  for (const location of shown) {
    const absolute = fileFromUri(location.uri);
    const rel = toPosixPath(path.relative(cwd, absolute)) || absolute;
    let source = sourceCache.get(absolute);
    if (source === undefined) {
      try {
        source = (await ops.readFile(absolute)).split("\n");
      } catch {
        source = null;
      }
      sourceCache.set(absolute, source);
    }
    const snippetRaw = source?.[location.range.start.line]?.trim() ?? "";
    const snippet =
      snippetRaw.length > MAX_SNIPPET_LENGTH
        ? `${snippetRaw.slice(0, MAX_SNIPPET_LENGTH)}…`
        : snippetRaw;
    const site = `${rel}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
    lines.push(snippet ? `${site} — ${snippet}` : site);
  }

  if (locations.length > shown.length) {
    lines.push(
      `… ${locations.length - shown.length} more result(s) not shown — raise max_results to see them`,
    );
  }
  return lines.join("\n");
}

/** `file://` URI → filesystem path, tolerating servers that send a bare path. */
function fileFromUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return decodeURIComponent(uri.replace(/^file:\/\//, ""));
  }
}
