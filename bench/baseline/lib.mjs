// Shared baseline-bench helpers — Sonnet 5 auth, measured turns, agent runs,
// fixture builders, result writers.
// Run from repo root: node bench/baseline/<script>.mjs
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RESULTS_DIR = path.join(ROOT, "bench", "baseline", "results");

const AI = await import(path.join(ROOT, "packages/gg-ai/dist/index.js"));
const AGENT = await import(path.join(ROOT, "packages/gg-agent/dist/index.js"));
const GGCODER = await import(path.join(ROOT, "packages/ggcoder/dist/index.js"));

export const { stream } = AI;
export const { Agent } = AGENT;
export const { createTools, buildSystemPrompt } = GGCODER;
export const REPO_ROOT = ROOT;

export const SONNET = "claude-sonnet-5";

let cachedCreds = null;
export async function anthropicCreds() {
  if (cachedCreds) return cachedCreds;
  const auth = new GGCODER.AuthStorage();
  cachedCreds = await auth.resolveCredentials("anthropic").catch((err) => {
    throw new Error(
      `Could not resolve Anthropic credentials (run: ggcoder login). ${err?.message ?? err}`,
    );
  });
  return cachedCreds;
}

export function estTokens(str) {
  return Math.ceil(String(str).length / 4);
}

export function freshCacheKey() {
  return `baseline-${randomUUID()}`;
}

/**
 * One measured Sonnet 5 turn. Tool calls are recorded but never executed.
 * Returns { ttftMs, totalMs, text, usage, toolCalls, response }.
 */
export async function sonnetTurn({ system, messages, tools, maxTokens = 256, thinking, promptCacheKey }) {
  const creds = await anthropicCreds();
  const t0 = Date.now();
  let ttftMs = 0;
  let text = "";
  const toolCalls = [];
  const msgs = system ? [{ role: "system", content: system }, ...messages] : messages;
  const s = stream({
    provider: "anthropic",
    model: SONNET,
    apiKey: creds.accessToken,
    accountId: creds.accountId,
    ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
    messages: msgs,
    ...(tools ? { tools } : {}),
    maxTokens,
    ...(promptCacheKey ? { promptCacheKey } : {}),
    ...(thinking ? { thinking } : {}),
  });
  for await (const ev of s) {
    if ((ev.type === "text_delta" || ev.type === "thinking_delta") && !ttftMs) {
      ttftMs = Date.now() - t0;
    }
    if (ev.type === "text_delta") text += ev.text;
    if (ev.type === "toolcall_end" && ev.toolCall) toolCalls.push(ev.toolCall);
  }
  const resp = await s;
  return { ttftMs, totalMs: Date.now() - t0, text, usage: resp.usage ?? {}, toolCalls, response: resp };
}

/**
 * Run a full agent task against Sonnet 5 with real tools. Records per-turn
 * usage, every tool call (name + args size + result size), wall time.
 * Returns { text, turns, toolCalls, usage, wallMs, error }.
 */
export async function runAgentTask({ system, prompt, tools, maxTurns = 15, maxTokens = 4096, thinking = "low" }) {
  const creds = await anthropicCreds();
  const t0 = Date.now();
  const turns = [];
  const toolCalls = [];
  let text = "";
  let error = null;
  const agent = new Agent({
    provider: "anthropic",
    model: SONNET,
    system,
    tools,
    apiKey: creds.accessToken,
    accountId: creds.accountId,
    ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
    maxTurns,
    maxTokens,
    thinking,
    promptCacheKey: freshCacheKey(),
  });
  try {
    const s = agent.prompt(prompt);
    for await (const ev of s) {
      if (ev.type === "text_delta") text += ev.text;
      else if (ev.type === "turn_end") turns.push({ usage: ev.usage ?? {} });
      else if (ev.type === "tool_call_start") {
        toolCalls.push({
          name: ev.name,
          argsChars: JSON.stringify(ev.args ?? {}).length,
        });
      } else if (ev.type === "tool_call_end") {
        const last = toolCalls[toolCalls.length - 1];
        if (last) {
          last.resultChars = String(ev.result ?? "").length;
          last.isError = ev.isError;
        }
      } else if (ev.type === "error") throw ev.error;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const sum = (k) => turns.reduce((a, t) => a + (t.usage[k] ?? 0), 0);
  return {
    text: text.trim(),
    turns,
    toolCalls,
    usage: {
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheRead: sum("cacheRead"),
      cacheWrite: sum("cacheWrite"),
    },
    llmCalls: turns.length,
    wallMs: Date.now() - t0,
    error,
  };
}

// ── Fixtures ───────────────────────────────────────────────

export async function makeTmpDir(prefix) {
  return mkdtemp(path.join(tmpdir(), `gg-baseline-${prefix}-`));
}

export async function cleanupDir(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Build a small TS project fixture where every file is CRLF-encoded. */
export async function writeCrlfCorpus(dir) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const crlf = (s) => s.replace(/\n/g, "\r\n");
  await mkdir(path.join(dir, "src"), { recursive: true });
  const files = {
    "src/math.ts": `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n`,
    "src/greet.ts": `export function greet(name: string): string {\n  const trimmed = name.trim();\n  return \`Hello, \${trimmed}!\`;\n}\n\nexport function farewell(name: string): string {\n  return \`Goodbye, \${name}.\`;\n}\n`,
    "src/config.ts": `export const config = {\n  env: "development",\n  retries: 3,\n  timeoutMs: 5000,\n  verbose: false,\n};\n`,
    "README.md": `# Fixture\n\nA tiny CRLF-encoded project.\n\n- math.ts: arithmetic\n- greet.ts: strings\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(dir, rel), crlf(content), "utf8");
  }
  return Object.keys(files);
}

/** Build a fixture tree with many small files (for glob/memory benches). */
export async function writeWideTree(dir, { dirs = 50, filesPerDir = 100 } = {}) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  for (let d = 0; d < dirs; d++) {
    const sub = path.join(dir, `pkg-${String(d).padStart(3, "0")}`);
    await mkdir(sub, { recursive: true });
    for (let f = 0; f < filesPerDir; f++) {
      await writeFile(
        path.join(sub, `file-${f}.ts`),
        `export const v${d}_${f} = ${d * filesPerDir + f};\n// padding padding padding padding\n`,
        "utf8",
      );
    }
  }
  return dirs * filesPerDir;
}

// ── Results ────────────────────────────────────────────────

export function writeResult(name, data) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = {
    benchmark: name,
    model: SONNET,
    date: new Date().toISOString(),
    ...data,
  };
  writeFileSync(path.join(RESULTS_DIR, `${name}.json`), JSON.stringify(out, null, 2));
  console.log(`\n→ wrote bench/baseline/results/${name}.json`);
  return out;
}

// ── Stats / formatting ─────────────────────────────────────

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function fmt(n, d = 0) {
  return Number(n).toFixed(d);
}
export function pct(part, whole) {
  return whole > 0 ? (100 * part) / whole : 0;
}
export function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}
export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
