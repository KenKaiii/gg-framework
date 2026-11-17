/**
 * Fast-apply vs current-edit benchmark — real-API measurement.
 *
 * Two strategies for the same edit task, measured end-to-end against live models:
 *
 *   BASELINE (what ggcoder does today): the frontier model emits full
 *   search/replace edit blocks (old_text + new_text, verbatim context). Our
 *   edit tool then applies them LOCALLY and instantly (no apply model).
 *
 *   FAST-APPLY (the proposed feature): the frontier model emits a terse "lazy"
 *   edit using `// ... existing code ...` markers (far fewer output tokens), and
 *   a cheap/fast "apply" model merges that lazy edit into the full file —
 *   regenerating the whole file as output.
 *
 * We measure, per task: frontier output tokens + time, apply-model output tokens
 * + time, total wall-clock, and an anchor-based correctness check.
 *
 * Usage:
 *   npx tsx src/core/fast-apply-benchmark.ts
 *
 * Env overrides:
 *   GG_FA_FRONTIER_PROVIDER / GG_FA_FRONTIER_MODEL   (default openai / gpt-6.2-sol)
 *   GG_FA_APPLY_PROVIDER     / GG_FA_APPLY_MODEL      (default gemini / gemini-3.1-flash-lite)
 */

import { stream, type Message, type StreamEvent, type Usage } from "@kenkaiiii/gg-ai";
import { AuthStorage } from "./auth-storage.js";

// ── Edit tasks: synthetic TS files of controlled sizes + a concrete edit ──

interface EditTask {
  name: string;
  approxLines: number;
  file: string;
  instruction: string;
  /** Substrings that MUST appear in the correctly-edited file. */
  mustContain: string[];
  /** Substrings that MUST still be present (unchanged anchors far from the edit). */
  mustPreserve: string[];
}

function genFile(lines: number): string {
  // Build a realistic-ish TS module with many small functions so the edit
  // target sits in the middle and most of the file is "untouched context".
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

function buildTasks(): EditTask[] {
  const sizes = [
    { name: "small", lines: 40 },
    { name: "medium", lines: 160 },
    { name: "large", lines: 420 },
  ];
  return sizes.map((s) => ({
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
}

// ── Prompts ──────────────────────────────────────────────────

function baselinePrompt(file: string, instruction: string): Message[] {
  return [
    {
      role: "system",
      content:
        "You are a coding agent's edit engine. Output ONLY search/replace edit blocks " +
        "in this exact format, nothing else:\n" +
        "<<<<<<< SEARCH\n(exact text from the file)\n=======\n(replacement text)\n>>>>>>> REPLACE\n" +
        "The SEARCH text must be copied verbatim from the file including surrounding context " +
        "so it matches uniquely. Do not output explanations.",
    },
    {
      role: "user",
      content: `FILE:\n\`\`\`ts\n${file}\n\`\`\`\n\nEDIT INSTRUCTION: ${instruction}`,
    },
  ];
}

function lazyEditPrompt(file: string, instruction: string): Message[] {
  return [
    {
      role: "system",
      content:
        "You are a coding agent. Output ONLY a concise 'lazy' edit snippet that shows the " +
        "change, using `// ... existing code ...` to elide all unchanged regions. " +
        "Show just enough surrounding context to locate the change unambiguously. " +
        "Do not reproduce the whole file. Do not explain.",
    },
    {
      role: "user",
      content: `FILE:\n\`\`\`ts\n${file}\n\`\`\`\n\nEDIT INSTRUCTION: ${instruction}`,
    },
  ];
}

function applyPrompt(file: string, lazyEdit: string): Message[] {
  return [
    {
      role: "system",
      content:
        "You merge a lazy edit into a source file. Given the ORIGINAL file and an EDIT " +
        "snippet that uses `// ... existing code ...` markers, output the COMPLETE final file " +
        "with the edit applied. Output ONLY the raw file contents — no markdown fences, no commentary.",
    },
    {
      role: "user",
      content: `ORIGINAL FILE:\n${file}\n\nEDIT:\n${lazyEdit}`,
    },
  ];
}

// ── One model call, timed ───────────────────────────────────

interface CallResult {
  text: string;
  outputTokens: number;
  inputTokens: number;
  cacheRead: number;
  ttftMs: number;
  wallMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function call(
  provider: string,
  model: string,
  apiKey: string,
  baseUrl: string | undefined,
  accountId: string | undefined,
  messages: Message[],
  maxTokens: number,
): Promise<CallResult> {
  // Retry transient provider errors (429/500) with exponential backoff so a
  // flaky cheap model doesn't abort the whole benchmark.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await callOnce(provider, model, apiKey, baseUrl, accountId, messages, maxTokens);
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
  apiKey: string,
  baseUrl: string | undefined,
  accountId: string | undefined,
  messages: Message[],
  maxTokens: number,
): Promise<CallResult> {
  const start = Date.now();
  let ttftMs = 0;
  let first = true;
  let text = "";

  const result = stream({
    provider: provider as never,
    model,
    messages,
    maxTokens,
    apiKey,
    baseUrl,
    accountId,
  });

  for await (const event of result as AsyncIterable<StreamEvent>) {
    if (first && (event.type === "text_delta" || event.type === "thinking_delta")) {
      ttftMs = Date.now() - start;
      first = false;
    }
    if (event.type === "text_delta") text += event.text;
  }
  const response: { message: Message; usage: Usage; stopReason: string } = await result.response;
  const wallMs = Date.now() - start;
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
    cacheRead: response.usage.cacheRead ?? 0,
    ttftMs,
    wallMs,
  };
}

// ── Correctness ─────────────────────────────────────────────

function checkAnchors(finalFile: string, task: EditTask): boolean {
  for (const s of task.mustContain) if (!finalFile.includes(s)) return false;
  for (const s of task.mustPreserve) if (!finalFile.includes(s)) return false;
  return true;
}

// ── Runner ──────────────────────────────────────────────────

interface Creds {
  apiKey: string;
  baseUrl?: string;
  accountId?: string;
}

interface Row {
  task: string;
  lines: number;
  // baseline
  baseFrontierTokens: number;
  baseFrontierMs: number;
  baseTotalMs: number;
  baseOk: boolean;
  // fast-apply
  faFrontierTokens: number;
  faFrontierMs: number;
  faApplyTokens: number;
  faApplyMs: number;
  faTotalMs: number;
  faOk: boolean;
}

async function main(): Promise<void> {
  const frontierProvider = process.env.GG_FA_FRONTIER_PROVIDER ?? "openai";
  const frontierModel = process.env.GG_FA_FRONTIER_MODEL ?? "gpt-6.2-sol";
  const applyProvider = process.env.GG_FA_APPLY_PROVIDER ?? "gemini";
  const applyModel = process.env.GG_FA_APPLY_MODEL ?? "gemini-3.1-flash-lite";

  const auth = new AuthStorage();
  await auth.load();

  const resolve = async (p: string): Promise<Creds> => {
    const c = await auth.resolveCredentials(p);
    return { apiKey: c.accessToken, baseUrl: c.baseUrl, accountId: c.accountId };
  };

  const fc = await resolve(frontierProvider);
  const ac = await resolve(applyProvider);

  console.log(`\n⚡ Fast-apply benchmark`);
  console.log(`   Frontier: ${frontierProvider}/${frontierModel}`);
  console.log(`   Apply:    ${applyProvider}/${applyModel}\n`);

  const tasks = buildTasks();
  const rows: Row[] = [];

  for (const task of tasks) {
    process.stdout.write(`▶ ${task.name} (${task.approxLines} lines)\n`);
    await sleep(2500); // space out calls to avoid cheap-model rate limits

    // ── BASELINE: frontier emits full search/replace blocks (local apply = ~0ms) ──
    const baseStart = Date.now();
    const baseFrontier = await call(
      frontierProvider,
      frontierModel,
      fc.apiKey,
      fc.baseUrl,
      fc.accountId,
      baselinePrompt(task.file, task.instruction),
      4096,
    );
    // Local apply is deterministic & instant; correctness = did the model produce
    // a SEARCH block whose target text actually exists in the file?
    const searchBlocks = [
      ...baseFrontier.text.matchAll(/<<<<<<< SEARCH\n([\s\S]*?)\n=======/g),
    ].map((m) => m[1]);
    const replaceBlocks = [
      ...baseFrontier.text.matchAll(/=======\n([\s\S]*?)\n>>>>>>> REPLACE/g),
    ].map((m) => m[1]);
    let baseFile = task.file;
    let baseApplied = searchBlocks.length > 0;
    for (let i = 0; i < searchBlocks.length; i++) {
      if (baseFile.includes(searchBlocks[i])) {
        baseFile = baseFile.replace(searchBlocks[i], replaceBlocks[i] ?? "");
      } else {
        baseApplied = false; // search text didn't match verbatim → would fail/retry
      }
    }
    const baseTotalMs = Date.now() - baseStart;
    const baseOk = baseApplied && checkAnchors(baseFile, task);
    process.stdout.write(
      `   baseline:  frontier ${baseFrontier.outputTokens} out tok, ${(baseFrontier.wallMs / 1000).toFixed(1)}s | apply ~0s | ${baseOk ? "OK" : "FAIL"}\n`,
    );

    // ── FAST-APPLY: frontier emits lazy edit, apply model merges whole file ──
    const faStart = Date.now();
    const faFrontier = await call(
      frontierProvider,
      frontierModel,
      fc.apiKey,
      fc.baseUrl,
      fc.accountId,
      lazyEditPrompt(task.file, task.instruction),
      2048,
    );
    const apply = await call(
      applyProvider,
      applyModel,
      ac.apiKey,
      ac.baseUrl,
      ac.accountId,
      applyPrompt(task.file, faFrontier.text),
      8192,
    );
    const faTotalMs = Date.now() - faStart;
    const faFile = apply.text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const faOk = checkAnchors(faFile, task);
    process.stdout.write(
      `   fast-apply: frontier ${faFrontier.outputTokens} out tok, ${(faFrontier.wallMs / 1000).toFixed(1)}s | apply ${apply.outputTokens} out tok, ${(apply.wallMs / 1000).toFixed(1)}s | ${faOk ? "OK" : "FAIL"}\n\n`,
    );

    rows.push({
      task: task.name,
      lines: task.approxLines,
      baseFrontierTokens: baseFrontier.outputTokens,
      baseFrontierMs: baseFrontier.wallMs,
      baseTotalMs,
      baseOk,
      faFrontierTokens: faFrontier.outputTokens,
      faFrontierMs: faFrontier.wallMs,
      faApplyTokens: apply.outputTokens,
      faApplyMs: apply.wallMs,
      faTotalMs,
      faOk,
    });
  }

  // ── Report ──
  console.log("\n══════════════════════ RESULTS ══════════════════════\n");
  console.log(
    "Task    Lines | BASELINE total | FAST-APPLY total |  Δ wall  | base/fa frontier-out-tok | OK",
  );
  for (const r of rows) {
    const delta = ((r.baseTotalMs - r.faTotalMs) / r.baseTotalMs) * 100;
    console.log(
      `${r.task.padEnd(7)} ${String(r.lines).padStart(4)} | ` +
        `${(r.baseTotalMs / 1000).toFixed(1).padStart(11)}s | ` +
        `${(r.faTotalMs / 1000).toFixed(1).padStart(13)}s | ` +
        `${(delta >= 0 ? "-" : "+") + Math.abs(delta).toFixed(0) + "%"}`.padStart(8) +
        ` | ${String(r.baseFrontierTokens).padStart(5)} / ${String(r.faFrontierTokens).padStart(5)}` +
        `         | ${r.baseOk ? "B" : "b"}${r.faOk ? "F" : "f"}`,
    );
  }
  const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  const baseTot = sum((r) => r.baseTotalMs);
  const faTot = sum((r) => r.faTotalMs);
  console.log(
    `\nTotals: baseline ${(baseTot / 1000).toFixed(1)}s vs fast-apply ${(faTot / 1000).toFixed(1)}s ` +
      `→ ${baseTot > faTot ? "fast-apply faster" : "baseline faster"} by ${Math.abs(((baseTot - faTot) / baseTot) * 100).toFixed(0)}%`,
  );
  console.log(
    `Frontier output tokens: baseline ${sum((r) => r.baseFrontierTokens)} vs fast-apply ${sum((r) => r.faFrontierTokens)} ` +
      `(${(((sum((r) => r.baseFrontierTokens) - sum((r) => r.faFrontierTokens)) / sum((r) => r.baseFrontierTokens)) * 100).toFixed(0)}% fewer)`,
  );
  console.log(
    `Correctness: baseline ${rows.filter((r) => r.baseOk).length}/${rows.length}, fast-apply ${rows.filter((r) => r.faOk).length}/${rows.length}`,
  );
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
