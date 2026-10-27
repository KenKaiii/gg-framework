/**
 * Semantic AST-chunk retrieval vs whole-file reads — real-API measurement of
 * whether Feature #3 is worth building.
 *
 * The claim (cocoindex-code / oh-my-pi): replacing "grep then read whole files"
 * with "retrieve only the relevant AST chunks" cuts ~70% of the tokens an agent
 * spends locating code, with no loss of answer quality. We test that directly on
 * OUR OWN repo against a live model.
 *
 * For a set of natural-language questions about real files in this repo, we build
 * three context strategies and ask the model the same question with each:
 *
 *   BASELINE (whole-file): deliver the FULL text of the top files a lexical
 *   grep would surface — this is what the agent reads today (read + grep).
 *
 *   SEMANTIC (AST chunks): parse every file into top-level declarations
 *   (functions / classes / interfaces / consts), rank chunks with a real BM25
 *   retriever, and deliver only the top-k chunks. No embedding model needed; a
 *   learned embedding retriever would land between BM25 and ORACLE.
 *
 *   ORACLE (upper bound): deliver only the hand-labelled answer chunk(s) — the
 *   best case any retriever could achieve.
 *
 * We measure, per question and strategy: INPUT tokens delivered (the headline
 * cost) and whether the model's answer was correct (deterministic keyword grade).
 * The verdict: does SEMANTIC reach BASELINE-level correctness at a fraction of
 * the input tokens?
 *
 * Usage:
 *   npx tsx src/core/semantic-search-benchmark.ts
 *
 * Env overrides:
 *   GG_SS_PROVIDER / GG_SS_MODEL   (default openai / gpt-6.1-sol)
 *   GG_SS_TOPK                     (chunks/files delivered, default 3)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stream, type Message, type StreamEvent, type Usage } from "@kenkaiiii/gg-ai";
import { AuthStorage } from "./auth-storage.js";
import { chunkFile, bm25Rank, rankFiles } from "./code-retrieval.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, ".."); // packages/ggcoder/src

// ── Corpus: real repo files + questions with deterministic graders ──

interface Question {
  q: string;
  /** files (relative to src/) that form the corpus for this question. */
  files: string[];
  /** the file + top-level symbol that actually answers it (oracle). */
  oracle: { file: string; symbol: string };
  /** lowercased tokens that must ALL appear in a correct answer. */
  mustInclude: string[];
}

const QUESTIONS: Question[] = [
  {
    q: "Which method resolves provider credentials and auto-refreshes expired OAuth tokens, and what happens if it is not logged in?",
    files: ["core/auth-storage.ts", "core/loop-breaker.ts", "tools/edit-diff.ts"],
    oracle: { file: "core/auth-storage.ts", symbol: "resolveCredentials" },
    mustInclude: ["resolvecredentials", "refresh"],
  },
  {
    q: "What function performs fuzzy text matching for the edit tool, and how does it tolerate indentation drift?",
    files: ["tools/edit-diff.ts", "core/auth-storage.ts", "core/checkpoint-store.ts"],
    oracle: { file: "tools/edit-diff.ts", symbol: "fuzzyFindText" },
    mustInclude: ["fuzzyfindtext", "indent"],
  },
  {
    q: "What restore modes does the checkpoint / rewind system support?",
    files: ["core/checkpoint-store.ts", "core/loop-breaker.ts", "tools/edit-diff.ts"],
    oracle: { file: "core/checkpoint-store.ts", symbol: "RestoreMode" },
    mustInclude: ["code", "conversation", "both"],
  },
];

// ── AST chunking + BM25 retrieval live in ./code-retrieval.ts  ──

// ── Model call ──────────────────────────────────────────────

interface Creds {
  apiKey: string;
  baseUrl?: string;
  accountId?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function ask(
  provider: string,
  model: string,
  c: Creds,
  context: string,
  question: string,
): Promise<CallResult> {
  const messages: Message[] = [
    {
      role: "system",
      content:
        "You answer questions about a codebase using ONLY the provided context. " +
        "Be specific: name the exact functions/types involved. If the context is insufficient, say so. " +
        "Answer in 1-3 sentences.",
    },
    { role: "user", content: `CONTEXT:\n${context}\n\nQUESTION: ${question}` },
  ];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      let text = "";
      const result = stream({
        provider: provider as never,
        model,
        messages,
        maxTokens: 512,
        apiKey: c.apiKey,
        baseUrl: c.baseUrl,
        accountId: c.accountId,
      });
      for await (const event of result as AsyncIterable<StreamEvent>) {
        if (event.type === "text_delta") text += event.text;
      }
      const response: { message: Message; usage: Usage } = await result.response;
      const content = response.message.content;
      const finalText =
        typeof content === "string"
          ? content
          : (content as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("");
      return {
        text: finalText || text,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      };
    } catch (err) {
      lastErr = err;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastErr;
}

export function grade(answer: string, mustInclude: string[]): boolean {
  const a = answer.toLowerCase();
  return mustInclude.every((t) => a.includes(t));
}

// ── Runner ──────────────────────────────────────────────────

interface Row {
  q: string;
  baseInTok: number;
  baseOk: boolean;
  semInTok: number;
  semOk: boolean;
  oracleInTok: number;
  oracleOk: boolean;
}

async function main(): Promise<void> {
  const provider = process.env.GG_SS_PROVIDER ?? "openai";
  const model = process.env.GG_SS_MODEL ?? "gpt-6.1-sol";
  const topK = Math.max(1, parseInt(process.env.GG_SS_TOPK ?? "3", 10));

  const auth = new AuthStorage();
  await auth.load();
  const cr = await auth.resolveCredentials(provider);
  const creds: Creds = { apiKey: cr.accessToken, baseUrl: cr.baseUrl, accountId: cr.accountId };

  console.log(`\n🔎 Semantic-search benchmark — ${provider}/${model} (top-${topK})\n`);

  const rows: Row[] = [];

  for (const q of QUESTIONS) {
    // Load the real corpus files; skip the question if any are missing/moved.
    const files = new Map<string, string>();
    let missing = false;
    for (const rel of q.files) {
      const abs = path.join(SRC, rel);
      if (!fs.existsSync(abs)) {
        console.log(`   ⚠ skipping question — missing ${rel}`);
        missing = true;
        break;
      }
      files.set(rel, fs.readFileSync(abs, "utf-8"));
    }
    if (missing) continue;

    // BASELINE context: full text of the top-k files a grep would surface.
    const baseFiles = rankFiles(q.q, files, topK);
    const baseContext = baseFiles.map((f) => `// FILE: ${f}\n${files.get(f)}`).join("\n\n");

    // SEMANTIC context: top-k AST chunks across all corpus files.
    const allChunks = [...files].flatMap(([rel, src]) => chunkFile(rel, src));
    const semChunks = bm25Rank(q.q, allChunks, topK);
    const semContext = semChunks.map((c) => `// ${c.file} → ${c.symbol}\n${c.text}`).join("\n\n");

    // ORACLE context: just the labelled answer chunk.
    const oracleChunk = allChunks.find(
      (c) => c.file === q.oracle.file && c.symbol === q.oracle.symbol,
    );
    const oracleContext = oracleChunk
      ? `// ${oracleChunk.file} → ${oracleChunk.symbol}\n${oracleChunk.text}`
      : semContext;

    process.stdout.write(`▶ ${q.q.slice(0, 64)}…\n`);
    await sleep(1200);
    const base = await ask(provider, model, creds, baseContext, q.q);
    await sleep(1200);
    const sem = await ask(provider, model, creds, semContext, q.q);
    await sleep(1200);
    const oracle = await ask(provider, model, creds, oracleContext, q.q);

    const row: Row = {
      q: q.q.slice(0, 40),
      baseInTok: base.inputTokens,
      baseOk: grade(base.text, q.mustInclude),
      semInTok: sem.inputTokens,
      semOk: grade(sem.text, q.mustInclude),
      oracleInTok: oracle.inputTokens,
      oracleOk: grade(oracle.text, q.mustInclude),
    };
    rows.push(row);
    process.stdout.write(
      `   baseline ${row.baseInTok} in tok ${row.baseOk ? "OK" : "FAIL"} | ` +
        `semantic ${row.semInTok} in tok ${row.semOk ? "OK" : "FAIL"} | ` +
        `oracle ${row.oracleInTok} in tok ${row.oracleOk ? "OK" : "FAIL"}\n\n`,
    );
  }

  if (rows.length === 0) {
    console.log("No questions ran (corpus files not found).");
    return;
  }

  // ── Report ──
  console.log("══════════════════════ RESULTS ══════════════════════\n");
  console.log(
    "Question                                 | base in-tok | sem in-tok | oracle | ok b/s/o",
  );
  for (const r of rows) {
    console.log(
      `${r.q.padEnd(40)} | ${String(r.baseInTok).padStart(11)} | ${String(r.semInTok).padStart(10)} | ` +
        `${String(r.oracleInTok).padStart(6)} | ${r.baseOk ? "1" : "0"}/${r.semOk ? "1" : "0"}/${r.oracleOk ? "1" : "0"}`,
    );
  }
  const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  const baseIn = sum((r) => r.baseInTok);
  const semIn = sum((r) => r.semInTok);
  const oracleIn = sum((r) => r.oracleInTok);
  console.log(
    `\nInput tokens to answer: baseline ${baseIn} | semantic ${semIn} ` +
      `(${(((baseIn - semIn) / baseIn) * 100).toFixed(0)}% fewer) | oracle ${oracleIn} ` +
      `(${(((baseIn - oracleIn) / baseIn) * 100).toFixed(0)}% fewer)`,
  );
  console.log(
    `Correctness: baseline ${rows.filter((r) => r.baseOk).length}/${rows.length} | ` +
      `semantic ${rows.filter((r) => r.semOk).length}/${rows.length} | ` +
      `oracle ${rows.filter((r) => r.oracleOk).length}/${rows.length}`,
  );
  console.log(
    `\nVerdict: worth building if SEMANTIC keeps correctness ≈ baseline while cutting input tokens. ` +
      `cocoindex claims ~70% fewer; ORACLE shows the ceiling a better (embedding) retriever could reach.\n`,
  );
}

// Run when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1]?.endsWith("semantic-search-benchmark.ts") ||
  process.argv[1]?.endsWith("semantic-search-benchmark.js") ||
  process.argv[1]?.endsWith("semantic-search-benchmark");

if (isDirectRun) {
  main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
