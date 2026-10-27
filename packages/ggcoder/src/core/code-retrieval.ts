/**
 * AST-aware code retrieval — the pure, UI-free core shared by the semantic-search
 * benchmark.
 *
 * `chunkFile` splits a source file into top-level declaration chunks (functions,
 * classes, interfaces, types, enums, consts) with their full bodies; `bm25Rank`
 * ranks chunks against a natural-language query with a real BM25 retriever (no
 * embedding dependency). Delivering only the top-ranked symbol chunks is what
 * cuts the input tokens an agent spends locating code versus reading whole files.
 *
 * TS/JS is chunked from a real AST. Every other supported language is chunked by
 * a line scanner: declaration patterns plus brace or indentation tracking. That
 * is deliberately dependency-free — a parser per language would cost five more
 * dependencies and a startup penalty on every search, to sharpen boundaries that
 * BM25 ranking is already tolerant of.
 */
import path from "node:path";
import ts from "typescript";
import {
  chunkByBraces,
  chunkByIndentation,
  type BraceLanguage,
} from "./code-retrieval-chunkers.js";

export interface Chunk {
  file: string;
  symbol: string;
  text: string;
  /** 1-based line number where the declaration starts (for `file:line` headers). */
  startLine: number;
}

/** Languages with a symbol chunker. Everything else is skipped by the caller. */
export type ChunkLanguage = "tsjs" | "python" | "go" | "rust" | "java" | "csharp";

const EXTENSION_LANGUAGES: Record<string, ChunkLanguage> = {
  ".ts": "tsjs",
  ".tsx": "tsjs",
  ".mts": "tsjs",
  ".cts": "tsjs",
  ".js": "tsjs",
  ".jsx": "tsjs",
  ".mjs": "tsjs",
  ".cjs": "tsjs",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
};

/** Which chunker handles a path, or undefined when none does. */
export function languageForFile(rel: string): ChunkLanguage | undefined {
  return EXTENSION_LANGUAGES[path.extname(rel).toLowerCase()];
}

/** Every extension the retrieval code can index, without leading dots. */
export const CHUNKABLE_EXTENSIONS: readonly string[] = Object.keys(EXTENSION_LANGUAGES).map((e) =>
  e.slice(1),
);

export function chunkFile(rel: string, source: string): Chunk[] {
  const language = languageForFile(rel);
  if (language === undefined) return [];
  if (language === "python") return chunkByIndentation(rel, source);
  if (language !== "tsjs") return chunkByBraces(rel, source, language as BraceLanguage);
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  const chunks: Chunk[] = [];
  sf.forEachChild((node) => {
    let symbol = "";
    if (ts.isFunctionDeclaration(node) && node.name) symbol = node.name.text;
    else if (ts.isClassDeclaration(node) && node.name) symbol = node.name.text;
    else if (ts.isInterfaceDeclaration(node)) symbol = node.name.text;
    else if (ts.isTypeAliasDeclaration(node)) symbol = node.name.text;
    else if (ts.isEnumDeclaration(node)) symbol = node.name.text;
    else if (ts.isVariableStatement(node)) {
      const d = node.declarationList.declarations[0];
      if (d && ts.isIdentifier(d.name)) symbol = d.name.text;
    }
    if (symbol) {
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      chunks.push({ file: rel, symbol, text: node.getText(sf), startLine });
    }
  });
  return chunks;
}

// ── Real BM25 retriever (no embedding dependency) ──

export function tokenize(s: string): string[] {
  return (
    s
      // split identifiers on camelCase / snake / non-word
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  );
}

export function bm25Rank(query: string, chunks: Chunk[], k: number): Chunk[] {
  const docs = chunks.map((c) => tokenize(`${c.symbol} ${c.text}`));
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const qToks = tokenize(query);
  const k1 = 1.5;
  const b = 0.75;
  const scored = docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of qToks) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      score += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgdl)));
    }
    return { i, score };
  });
  return scored
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k)
    .map((s) => chunks[s.i]!);
}

/** Whole-file baseline: rank files by BM25 over their full text, take top-k. */
export function rankFiles(query: string, files: Map<string, string>, k: number): string[] {
  const chunks: Chunk[] = [...files].map(([file, text]) => ({
    file,
    symbol: file,
    text,
    startLine: 1,
  }));
  return bm25Rank(query, chunks, k).map((c) => c.file);
}
