/**
 * Hashline (hash-anchored edits) vs current string-match edit — real-API
 * measurement of whether Feature #2 is worth building.
 *
 * Two strategies produce the SAME edit against the SAME file, measured against
 * live gpt-5.5:
 *
 *   BASELINE (what ggcoder does today): the model emits { old_text, new_text }
 *   edits where old_text must be copied VERBATIM from the file with enough
 *   surrounding context to match uniquely (this is exactly our edit tool's
 *   contract — see tools/edit.ts). The reproduced context is what costs output
 *   tokens, and a non-unique / drifted old_text is what causes apply failures.
 *
 *   HASHLINE (the proposed feature): every line is shown with a short content-
 *   hash anchor (`a3f1│<line>`). The model references anchors instead of
 *   reproducing text — it emits { from, to, lines } where from/to are anchors.
 *   Anchors are unique by construction, so an edit either resolves exactly or is
 *   rejected (never silently corrupts), and the model writes far fewer tokens.
 *
 * We measure, per task: model OUTPUT tokens (the headline -61% claim), whether
 * the edit applied cleanly + produced the correct file, and an anchor-uniqueness
 * / safety check. Edits are graded deterministically — no second model needed.
 *
 * The BASELINE apply path runs ggcoder's REAL edit ladder (fuzzy match +
 * indent-flex + blank-edge strip + dotdotdots — the same edit-diff functions
 * tools/edit.ts uses), so baseline numbers reflect what our tool actually
 * recovers, not a naive exact-replace.
 *
 * Usage:
 *   npx tsx src/core/hashline-edit-benchmark.ts
 *
 * Env overrides:
 *   GG_HL_PROVIDER / GG_HL_MODEL   (default anthropic / claude-sonnet-5)
 *   GG_HL_REPEAT                   (runs per task, default 1 — raise to average noise)
 */

import { stream, type Message, type StreamEvent, type Usage } from "@kenkaiiii/gg-ai";
import { AuthStorage } from "./auth-storage.js";
import { anchorFile, type AnchoredFile } from "./hashline.js";
import {
  fuzzyFindText,
  countOccurrences,
  applyMissingLeadingWhitespace,
  applyDotdotdots,
  stripBlankEdges,
} from "../tools/edit-diff.js";

// ── Edit tasks: synthetic TS files + a concrete, anchor-checkable edit ──

export interface EditTask {
  name: string;
  approxLines: number;
  file: string;
  instruction: string;
  /** Substrings that MUST appear in the correctly-edited file. */
  mustContain: string[];
  /** Substrings that MUST still be present (unchanged anchors far from the edit). */
  mustPreserve: string[];
  /** Optional extra validator for tasks where substring checks are too weak. */
  validate?: (file: string) => boolean;
}

export function genFile(lines: number): string {
  const head = [
    `import { EventEmitter } from "node:events";`,
    `import { performance } from "node:perf_hooks";`,
    ``,
    `/** Auto-generated module with ${lines} lines for benchmarking. */`,
    `export interface Config {`,
    `  retries: number;`,
    `  timeoutMs: number;`,
    `  label: string;`,
    `}`,
    ``,
    `const DEFAULT_TIMEOUT = 3000;`,
    ``,
  ];
  const body: string[] = [];
  let n = 0;
  while (head.length + body.length < lines - 12) {
    body.push(
      `export function task${n}(x: number): number {`,
      `  // step ${n}`,
      `  const y = x * ${n + 1} + DEFAULT_TIMEOUT;`,
      `  return y - ${n};`,
      `}`,
      ``,
    );
    n++;
  }
  const tail = [
    `export function computeTimeout(cfg: Config): number {`,
    `  return cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT;`,
    `}`,
    ``,
    `export const SENTINEL_TAIL = "anchor_${lines}_end";`,
    ``,
  ];
  return [...head, ...body, ...tail].join("\n");
}

/** Near-identical handler blocks — uniqueness pressure for string matching. */
export function genRepetitiveFile(blocks: number): string {
  const out: string[] = [
    `import { parse, ok, error, type Request, type Response } from "./http.js";`,
    ``,
  ];
  for (let i = 0; i < blocks; i++) {
    out.push(
      `export function handleCase${i}(req: Request): Response {`,
      `  const value = parse(req);`,
      `  if (!value) {`,
      `    return error(400);`,
      `  }`,
      `  return ok(value);`,
      `}`,
      ``,
    );
  }
  out.push(`export const HANDLER_COUNT = ${blocks};`, ``);
  return out.join("\n");
}

export function buildTasks(): EditTask[] {
  const sizes = [
    { name: "small", lines: 40 },
    { name: "medium", lines: 160 },
    { name: "large", lines: 420 },
  ];
  const sized: EditTask[] = sizes.map((s) => ({
    name: s.name,
    approxLines: s.lines,
    file: genFile(s.lines),
    instruction:
      "Change `computeTimeout` so that when `cfg.retries` is greater than 0 it returns " +
      "`cfg.timeoutMs * cfg.retries` (capped at 30000), otherwise it keeps the existing behaviour. " +
      "Also add a one-line JSDoc comment above the function describing it.",
    mustContain: ["cfg.timeoutMs * cfg.retries", "30000", "computeTimeout"],
    mustPreserve: ["DEFAULT_TIMEOUT = 3000", `SENTINEL_TAIL = "anchor_${s.lines}_end"`, "task0"],
  }));

  // Repetitive: 12 identical bodies; only handleCase7 must change.
  const repFile = genRepetitiveFile(12);
  const repetitive: EditTask = {
    name: "repeat",
    approxLines: repFile.split("\n").length,
    file: repFile,
    instruction:
      "In `handleCase7` ONLY, change `error(400)` to `error(422)`. " +
      "Every other handler must keep returning error(400).",
    mustContain: ["error(422)"],
    mustPreserve: ["HANDLER_COUNT = 12", "handleCase0", "handleCase11"],
    validate: (file) => {
      if (countOccurrences(file, "error(422)") !== 1) return false;
      if (countOccurrences(file, "error(400)") !== 11) return false;
      const seven = file.indexOf("export function handleCase7");
      const eight = file.indexOf("export function handleCase8");
      const idx = file.indexOf("error(422)");
      return seven !== -1 && idx > seven && (eight === -1 || idx < eight);
    },
  };

  // Multi-edit: three scattered changes in one response.
  const multiFile = genFile(200);
  const multi: EditTask = {
    name: "multi",
    approxLines: 200,
    file: multiFile,
    instruction:
      "Make THREE changes: (1) rename the constant `DEFAULT_TIMEOUT` to `FALLBACK_TIMEOUT_MS` " +
      "everywhere it appears, (2) add a `maxRetries: number;` field to the `Config` interface, " +
      "(3) in `computeTimeout`, return `0` when `cfg.label` is the empty string (before the " +
      "existing logic).",
    mustContain: ["FALLBACK_TIMEOUT_MS", "maxRetries: number;", "cfg.label"],
    mustPreserve: [`SENTINEL_TAIL = "anchor_200_end"`, "task0"],
    validate: (file) => countOccurrences(file, "DEFAULT_TIMEOUT") === 0,
  };

  return [...sized, repetitive, multi];
}

// ── Hashline anchoring lives in ./hashline.ts (shared with the read/edit tools) ──

// ── Prompts ─────────────────────────────────────────────────

function baselinePrompt(file: string, instruction: string): Message[] {
  return [
    {
      role: "system",
      content:
        "You are a coding agent's edit engine. Apply the edit by emitting search/replace " +
        "operations. Output ONLY raw JSON, no markdown fence, in this shape:\n" +
        `{"edits":[{"old_text":"<verbatim slice from the file>","new_text":"<replacement>"}]}\n` +
        "RULES: old_text MUST be copied verbatim from the file, including enough surrounding " +
        "context lines that it matches EXACTLY ONE location. Do not paraphrase. Do not explain.",
    },
    { role: "user", content: `FILE:\n\`\`\`ts\n${file}\n\`\`\`\n\nEDIT: ${instruction}` },
  ];
}

function hashlinePrompt(rendered: string, instruction: string): Message[] {
  return [
    {
      role: "system",
      content:
        "You are a coding agent's edit engine. The file is shown with a unique 4-char anchor " +
        "before each line as `anchor│code`. The anchors are NOT part of the file. Apply the edit " +
        "by referencing anchors instead of retyping code. Output ONLY raw JSON, no markdown fence:\n" +
        `{"edits":[{"from":"<anchor>","to":"<anchor>","lines":["<new line 1>","<new line 2>"]}]}\n` +
        "Each edit REPLACES the inclusive span of lines from anchor `from` to anchor `to` with the " +
        "`lines` array (write the full replacement lines, with correct indentation; never include the " +
        "anchor prefixes). For a single-line change, set from === to. To ADD new lines (e.g. a JSDoc " +
        "comment above a function), pick the existing line you are augmenting as both from and to, and " +
        "put [new line(s), ...that original line] in `lines`. Every `from`/`to` MUST be an anchor that " +
        "appears in the file. Do not explain.",
    },
    { role: "user", content: `FILE (anchored):\n${rendered}\n\nEDIT: ${instruction}` },
  ];
}

// ── Apply + grade (deterministic) ───────────────────────────

export interface ApplyOutcome {
  applied: boolean;
  correct: boolean;
  /** edits whose locator was non-unique / unresolvable (would error in the real tool). */
  ambiguousEdits: number;
  parsedEdits: number;
}

export function stripFence(s: string): string {
  return s
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();
}

/**
 * Parse the model's JSON envelope, tolerating literal (unescaped) newlines and
 * tabs inside string values. In production, edits arrive as STRUCTURED
 * tool-call arguments — the JSON envelope is a benchmark artifact — so both
 * strategies get the same repair to keep the comparison about the EDIT FORMAT,
 * not about JSON string-escaping discipline.
 */
export function parseEnvelope<T>(raw: string): T | null {
  const text = stripFence(raw);
  try {
    return JSON.parse(text) as T;
  } catch {
    // Repair pass: escape raw control chars that appear inside string literals.
    let out = "";
    let inString = false;
    let escaped = false;
    for (const ch of text) {
      if (inString) {
        if (escaped) {
          out += ch;
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          out += ch;
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
          out += ch;
          continue;
        }
        if (ch === "\n") {
          out += "\\n";
          continue;
        }
        if (ch === "\r") {
          out += "\\r";
          continue;
        }
        if (ch === "\t") {
          out += "\\t";
          continue;
        }
        out += ch;
        continue;
      }
      if (ch === '"') inString = true;
      out += ch;
    }
    try {
      return JSON.parse(out) as T;
    } catch {
      return null;
    }
  }
}

export function checkAnchors(file: string, task: EditTask): boolean {
  for (const s of task.mustContain) if (!file.includes(s)) return false;
  for (const s of task.mustPreserve) if (!file.includes(s)) return false;
  if (task.validate && !task.validate(file)) return false;
  return true;
}

/**
 * ggcoder's REAL apply ladder, mirroring tools/edit.ts:
 *   1. exact + smart-quote/dash fuzzy
 *   2. indent-flex
 *   3. blank-edge strip, retry 1+2
 *   4. dotdotdots elision
 * Returns the new working buffer or a failure reason.
 */
export function applyLadder(
  working: string,
  oldText: string,
  newText: string,
): { ok: true; working: string } | { ok: false; reason: "not_found" | "ambiguous" } {
  const occurrences = countOccurrences(working, oldText);
  if (occurrences > 1) return { ok: false, reason: "ambiguous" };
  if (occurrences === 1) {
    const match = fuzzyFindText(working, oldText);
    if (match.found) {
      return {
        ok: true,
        working:
          working.slice(0, match.index) + newText + working.slice(match.index + match.matchLength),
      };
    }
  }
  // not_found → fallback ladder (ambiguous deliberately does not fall through)
  const flexed = applyMissingLeadingWhitespace(working, oldText, newText);
  if (flexed !== null) return { ok: true, working: flexed };
  const stripped = stripBlankEdges(oldText);
  if (stripped !== null) {
    const strippedFlexed = applyMissingLeadingWhitespace(working, stripped, newText);
    if (strippedFlexed !== null) return { ok: true, working: strippedFlexed };
    if (countOccurrences(working, stripped) === 1) {
      const m = fuzzyFindText(working, stripped);
      if (m.found) {
        return {
          ok: true,
          working: working.slice(0, m.index) + newText + working.slice(m.index + m.matchLength),
        };
      }
    }
  }
  const elided = applyDotdotdots(working, oldText, newText);
  if (elided !== null) return { ok: true, working: elided };
  return { ok: false, reason: "not_found" };
}

export function applyBaseline(raw: string, task: EditTask): ApplyOutcome {
  const parsed = parseEnvelope<{ edits?: Array<{ old_text: string; new_text: string }> }>(raw);
  if (parsed === null) {
    return { applied: false, correct: false, ambiguousEdits: 0, parsedEdits: 0 };
  }
  const edits = parsed.edits ?? [];
  let file = task.file;
  let applied = edits.length > 0;
  let ambiguous = 0;
  for (const e of edits) {
    // Run the REAL edit ladder (fuzzy + indent-flex + blank-strip + dotdotdots),
    // so the baseline gets full credit for everything our tool recovers today.
    const result = applyLadder(file, e.old_text ?? "", e.new_text ?? "");
    if (result.ok) {
      file = result.working;
    } else {
      ambiguous++;
      applied = false;
    }
  }
  return {
    applied,
    correct: applied && checkAnchors(file, task),
    ambiguousEdits: ambiguous,
    parsedEdits: edits.length,
  };
}

export function applyHashline(raw: string, task: EditTask, anchored: AnchoredFile): ApplyOutcome {
  const parsed = parseEnvelope<{ edits?: Array<{ from: string; to: string; lines: string[] }> }>(
    raw,
  );
  if (parsed === null) {
    return { applied: false, correct: false, ambiguousEdits: 0, parsedEdits: 0 };
  }
  const edits = parsed.edits ?? [];
  // Resolve every anchor first; reject the whole patch if any is unresolvable
  // (this is the corruption-avoidance property — anchors must hit exactly once).
  let ambiguous = 0;
  const resolved: Array<{ from: number; to: number; lines: string[] }> = [];
  for (const e of edits) {
    const from = anchored.anchorToIndex.get(e.from);
    const to = anchored.anchorToIndex.get(e.to);
    if (from === undefined || to === undefined || from > to) {
      ambiguous++;
      continue;
    }
    resolved.push({ from, to, lines: e.lines ?? [] });
  }
  if (resolved.length !== edits.length || edits.length === 0) {
    return { applied: false, correct: false, ambiguousEdits: ambiguous, parsedEdits: edits.length };
  }
  // Apply bottom-up so earlier indices stay valid.
  resolved.sort((a, b) => b.from - a.from);
  const out = [...anchored.lines];
  for (const r of resolved) out.splice(r.from, r.to - r.from + 1, ...r.lines);
  const file = out.join("\n");
  return {
    applied: true,
    correct: checkAnchors(file, task),
    ambiguousEdits: ambiguous,
    parsedEdits: edits.length,
  };
}

// ── One model call, timed ───────────────────────────────────

interface CallResult {
  text: string;
  outputTokens: number;
  inputTokens: number;
  wallMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Creds {
  apiKey: string;
  baseUrl?: string;
  accountId?: string;
}

async function call(
  provider: string,
  model: string,
  c: Creds,
  messages: Message[],
  maxTokens: number,
): Promise<CallResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await callOnce(provider, model, c, messages, maxTokens);
    } catch (err) {
      lastErr = err;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function callOnce(
  provider: string,
  model: string,
  c: Creds,
  messages: Message[],
  maxTokens: number,
): Promise<CallResult> {
  const start = Date.now();
  let text = "";
  const result = stream({
    provider: provider as never,
    model,
    messages,
    maxTokens,
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
    outputTokens: response.usage.outputTokens,
    inputTokens: response.usage.inputTokens,
    wallMs: Date.now() - start,
  };
}

// ── Runner ──────────────────────────────────────────────────

interface Row {
  task: string;
  lines: number;
  baseOutTok: number;
  baseInTok: number;
  baseOk: boolean;
  baseAmbiguous: number;
  baseMs: number;
  hlOutTok: number;
  hlInTok: number;
  hlOk: boolean;
  hlAmbiguous: number;
  hlMs: number;
}

async function main(): Promise<void> {
  const provider = process.env.GG_HL_PROVIDER ?? "anthropic";
  const model = process.env.GG_HL_MODEL ?? "claude-sonnet-5";
  const repeat = Math.max(1, parseInt(process.env.GG_HL_REPEAT ?? "1", 10));

  const auth = new AuthStorage();
  await auth.load();
  const cr = await auth.resolveCredentials(provider);
  const creds: Creds = { apiKey: cr.accessToken, baseUrl: cr.baseUrl, accountId: cr.accountId };

  console.log(`\n🔗 Hashline edit benchmark — ${provider}/${model} (repeat ${repeat})\n`);

  const tasks = buildTasks();
  const rows: Row[] = [];

  for (const task of tasks) {
    const anchored = anchorFile(task.file);
    const agg: Row = {
      task: task.name,
      lines: task.approxLines,
      baseOutTok: 0,
      baseInTok: 0,
      baseOk: true,
      baseAmbiguous: 0,
      baseMs: 0,
      hlOutTok: 0,
      hlInTok: 0,
      hlOk: true,
      hlAmbiguous: 0,
      hlMs: 0,
    };
    let baseOkCount = 0;
    let hlOkCount = 0;

    for (let r = 0; r < repeat; r++) {
      process.stdout.write(`▶ ${task.name} (${task.approxLines} lines) run ${r + 1}/${repeat}\n`);
      await sleep(1500);

      const base = await call(
        provider,
        model,
        creds,
        baselinePrompt(task.file, task.instruction),
        8192,
      );
      const baseOut = applyBaseline(base.text, task);
      if (!baseOut.correct && process.env.GG_HL_DEBUG) {
        process.stdout.write(`   [debug] baseline raw:\n${base.text.slice(0, 1200)}\n`);
      }
      agg.baseOutTok += base.outputTokens;
      agg.baseInTok += base.inputTokens;
      agg.baseAmbiguous += baseOut.ambiguousEdits;
      agg.baseMs += base.wallMs;
      if (baseOut.correct) baseOkCount++;
      process.stdout.write(
        `   baseline: ${base.outputTokens} out tok | ${baseOut.correct ? "OK" : "FAIL"}` +
          `${baseOut.ambiguousEdits ? ` (${baseOut.ambiguousEdits} non-unique)` : ""}\n`,
      );

      await sleep(1500);
      // Same cap as baseline — an asymmetric cap truncates multi-edit responses
      // and shows up as a fake FAIL.
      const hl = await call(
        provider,
        model,
        creds,
        hashlinePrompt(anchored.rendered, task.instruction),
        8192,
      );
      const hlOut = applyHashline(hl.text, task, anchored);
      if (!hlOut.correct && process.env.GG_HL_DEBUG) {
        process.stdout.write(`   [debug] hashline raw:\n${hl.text.slice(0, 1200)}\n`);
      }
      agg.hlOutTok += hl.outputTokens;
      agg.hlInTok += hl.inputTokens;
      agg.hlAmbiguous += hlOut.ambiguousEdits;
      agg.hlMs += hl.wallMs;
      if (hlOut.correct) hlOkCount++;
      process.stdout.write(
        `   hashline: ${hl.outputTokens} out tok | ${hlOut.correct ? "OK" : "FAIL"}` +
          `${hlOut.ambiguousEdits ? ` (${hlOut.ambiguousEdits} unresolved)` : ""}\n\n`,
      );
    }

    agg.baseOutTok = Math.round(agg.baseOutTok / repeat);
    agg.baseInTok = Math.round(agg.baseInTok / repeat);
    agg.baseMs = Math.round(agg.baseMs / repeat);
    agg.hlOutTok = Math.round(agg.hlOutTok / repeat);
    agg.hlInTok = Math.round(agg.hlInTok / repeat);
    agg.hlMs = Math.round(agg.hlMs / repeat);
    agg.baseOk = baseOkCount === repeat;
    agg.hlOk = hlOkCount === repeat;
    rows.push(agg);
  }

  // ── Report ──
  console.log("══════════════════════ RESULTS ══════════════════════\n");
  console.log(
    "Task    Lines | base out-tok | hashline out-tok |  Δ out  | in-tok base/hl | ms base/hl | OK base/hl",
  );
  for (const r of rows) {
    const delta = r.baseOutTok > 0 ? ((r.baseOutTok - r.hlOutTok) / r.baseOutTok) * 100 : 0;
    console.log(
      `${r.task.padEnd(7)} ${String(r.lines).padStart(4)} | ` +
        `${String(r.baseOutTok).padStart(12)} | ${String(r.hlOutTok).padStart(16)} | ` +
        `${((delta >= 0 ? "-" : "+") + Math.abs(delta).toFixed(0) + "%").padStart(7)} | ` +
        `${String(r.baseInTok).padStart(6)}/${String(r.hlInTok).padStart(6)} | ` +
        `${String(r.baseMs).padStart(5)}/${String(r.hlMs).padStart(5)} | ` +
        `${r.baseOk ? "OK" : "FAIL"}/${r.hlOk ? "OK" : "FAIL"}`,
    );
  }
  const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  const baseOut = sum((r) => r.baseOutTok);
  const hlOut = sum((r) => r.hlOutTok);
  const baseIn = sum((r) => r.baseInTok);
  const hlIn = sum((r) => r.hlInTok);
  console.log(
    `\nOutput tokens: baseline ${baseOut} vs hashline ${hlOut} ` +
      `→ ${baseOut > hlOut ? `${(((baseOut - hlOut) / baseOut) * 100).toFixed(0)}% fewer` : "no win"} ` +
      `(claim from oh-my-pi: ~61% fewer)`,
  );
  console.log(
    `Input tokens:  baseline ${baseIn} vs hashline ${hlIn} ` +
      `(hashline adds the anchor column: ${hlIn > baseIn ? `+${(((hlIn - baseIn) / baseIn) * 100).toFixed(0)}% input` : "no overhead"})`,
  );
  console.log(
    `Correctness:   baseline ${rows.filter((r) => r.baseOk).length}/${rows.length}, ` +
      `hashline ${rows.filter((r) => r.hlOk).length}/${rows.length}`,
  );
  console.log(
    `Locator misses: baseline ${sum((r) => r.baseAmbiguous)} non-unique/not-found, ` +
      `hashline ${sum((r) => r.hlAmbiguous)} unresolved (rejected before corruption)`,
  );
  console.log(
    `\nVerdict: hashline wins if output-token drop is large AND correctness ≥ baseline. ` +
      `Net input overhead from the anchor column is the cost to weigh against it.\n`,
  );
}

// Run when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1]?.endsWith("hashline-edit-benchmark.ts") ||
  process.argv[1]?.endsWith("hashline-edit-benchmark.js") ||
  process.argv[1]?.endsWith("hashline-edit-benchmark");

if (isDirectRun) {
  main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
