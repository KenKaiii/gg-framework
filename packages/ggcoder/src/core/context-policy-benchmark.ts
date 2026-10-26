/**
 * Context-policy A/B benchmark: speed, cost and reliability measured TOGETHER
 * for the context/cache policies of a real AgentSession (real agent loop, real
 * tools, real pruning, compaction and prompt caching, live provider).
 *
 * Every run gets:
 *   1. a fresh fixture repo (small JS project with a node:test suite);
 *   2. a seeded long-session history: real engine source files read earlier,
 *      plus STALE reads of fixture files that have since changed (the situation
 *      a goal run hits when sub-agents, the user or git change files);
 *   3. a pre-warmed prompt cache, like an ongoing session;
 *   4. one coding task, graded afterwards by hidden tests copied in only after
 *      the agent finishes. A wrong answer that matches the stale history is
 *      counted separately as "stale".
 *
 * Arms change ONE thing against the current defaults. Settings are overridden
 * in the child process only (SettingsManager.prototype.get); ~/.gg/settings.json
 * is never written. Credentials come from the shared ~/.gg/auth.json exactly as
 * any other GG process uses them.
 *
 * Usage:
 *   pnpm --filter @kenkaiiii/ggcoder bench:context [--arms a,b] [--tasks t1,t2]
 *     [--reps 2] [--concurrency 3] [--history 450000] [--model claude-haiku-5-5]
 *     [--timeout-min 8] [--out <dir>]
 *   pnpm --filter @kenkaiiii/ggcoder bench:context --report <out dir>
 *   pnpm --filter @kenkaiiii/ggcoder bench:context --selftest   (graders only, no API calls)
 *
 * Cost is a LIST-PRICE ESTIMATE (only Haiku 5.5 prices are encoded) and does
 * not include the compaction summary call's cache reads (only its logged
 * input/output). Prewarm usage is reported separately, not in the run cost.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import { closeLogger, initLogger } from "./logger.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager, type Settings } from "./settings-manager.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const PROVIDER = "anthropic";

// ── Arms: one variable changed against the current defaults ──────────────────

type SettingOverrides = Partial<
  Pick<Settings, "compactThreshold" | "autoCompact" | "speedProfile" | "cachePrewarm">
>;

interface Arm {
  id: string;
  label: string;
  history: boolean;
  settings: SettingOverrides;
  thinking: ThinkingLevel;
  tail?: string;
}

/** Pinned so a change in the user's settings.json cannot shift the baseline. */
const DEFAULT_SETTINGS: Required<SettingOverrides> = {
  compactThreshold: 0.85,
  autoCompact: true,
  speedProfile: "optimized",
  cachePrewarm: true,
};

const REGROUND_TAIL =
  "Files can change outside this conversation (the user, other agents, git). Before relying on " +
  "file contents or values seen earlier in this conversation, re-read the file; treat earlier " +
  "tool output and your earlier summaries as possibly outdated.";

const ARMS: readonly Arm[] = [
  {
    id: "baseline",
    label: "current defaults: compact 0.85, prune on, 1-h cache, thinking medium",
    history: true,
    settings: {},
    thinking: "medium",
  },
  {
    id: "fresh",
    label: "new session, no prior history",
    history: false,
    settings: {},
    thinking: "medium",
  },
  {
    id: "no-prune",
    label: "no pruning/compaction during the run",
    history: true,
    settings: { autoCompact: false },
    thinking: "medium",
  },
  {
    id: "compact-0.4",
    label: "compaction threshold 0.4",
    history: true,
    settings: { compactThreshold: 0.4 },
    thinking: "medium",
  },
  {
    id: "compact-0.2",
    label: "compaction threshold 0.2",
    history: true,
    settings: { compactThreshold: 0.2 },
    thinking: "medium",
  },
  {
    id: "cache-5min",
    label: "5-minute cache (speedProfile baseline)",
    history: true,
    settings: { speedProfile: "baseline" },
    thinking: "medium",
  },
  {
    id: "thinking-low",
    label: "thinking low",
    history: true,
    settings: {},
    thinking: "low",
  },
  {
    id: "thinking-high",
    label: "thinking high",
    history: true,
    settings: {},
    thinking: "high",
  },
  {
    id: "reground",
    label: "prompt: re-read files before relying on earlier output",
    history: true,
    settings: {},
    thinking: "medium",
    tail: REGROUND_TAIL,
  },
];

// ── Fixture repo (current state) and the stale versions seen in history ─────

const FIXTURE: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify(
    {
      name: "cart-service",
      version: "1.4.0",
      type: "module",
      scripts: { test: "node --test test/*.test.js" },
    },
    null,
    2,
  )}\n`,
  "src/config.js": [
    "// Runtime limits. Changed in 1.4.0: retries 3 -> 5, backoff 100 -> 250 ms, currency USD -> EUR.",
    "export const MAX_RETRIES = 5;",
    "export const BACKOFF_MS = 250;",
    'export const CURRENCY = "EUR";',
    "",
  ].join("\n"),
  "src/cart.js": [
    'import { CURRENCY } from "./config.js";',
    "",
    "/** Price of one cart line in cents. */",
    "export function lineTotalCents(item) {",
    "  return item.unitCents * item.qty;",
    "}",
    "",
    "/** Cart total in cents after an optional percentage discount. */",
    "export function cartTotalCents(items, discountPct = 0) {",
    "  const subtotal = items.reduce((sum, item) => sum + lineTotalCents(item), 0);",
    "  const discount = Math.floor((subtotal * discountPct) / 100);",
    "  return subtotal - discount;",
    "}",
    "",
    "export function formatTotal(cents) {",
    "  return `${(cents / 100).toFixed(2)} ${CURRENCY}`;",
    "}",
    "",
  ].join("\n"),
  "src/cli.js": [
    "#!/usr/bin/env node",
    'import fs from "node:fs";',
    'import { cartTotalCents, formatTotal } from "./cart.js";',
    "",
    'const [file] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));',
    "if (!file) {",
    '  console.error("usage: cli <cart.json>");',
    "  process.exit(2);",
    "}",
    'const cart = JSON.parse(fs.readFileSync(file, "utf8"));',
    "console.log(formatTotal(cartTotalCents(cart.items, cart.discountPct ?? 0)));",
    "",
  ].join("\n"),
  "fixtures/cart.json": `${JSON.stringify(
    {
      items: [
        { sku: "MUG", unitCents: 1250, qty: 2 },
        { sku: "TEA", unitCents: 799, qty: 3 },
      ],
      discountPct: 20,
    },
    null,
    2,
  )}\n`,
  "test/cart.test.js": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { cartTotalCents, lineTotalCents } from "../src/cart.js";',
    "",
    'test("line total", () => {',
    "  assert.equal(lineTotalCents({ unitCents: 250, qty: 4 }), 1000);",
    "});",
    "",
    'test("cart total without discount", () => {',
    "  assert.equal(cartTotalCents([{ unitCents: 500, qty: 2 }, { unitCents: 120, qty: 1 }]), 1120);",
    "});",
    "",
    'test("cart total with an exact discount", () => {',
    "  assert.equal(cartTotalCents([{ unitCents: 1000, qty: 3 }], 10), 2700);",
    "});",
    "",
  ].join("\n"),
};

const STALE: Readonly<Record<string, string>> = {
  "src/config.js": [
    "// Runtime limits.",
    "export const MAX_RETRIES = 3;",
    "export const BACKOFF_MS = 100;",
    'export const CURRENCY = "USD";',
    "",
  ].join("\n"),
  "src/cart.js": [
    'import { CURRENCY } from "./config.js";',
    "",
    "export function computeTotal(lines, discount) {",
    "  let total = 0;",
    "  for (const line of lines) total += line.price * line.quantity;",
    "  return total - Math.floor((total * (discount || 0)) / 100);",
    "}",
    "",
    "export function display(total) {",
    "  return `$${(total / 100).toFixed(2)} ${CURRENCY}`;",
    "}",
    "",
  ].join("\n"),
  "src/cli.js": [
    'import fs from "node:fs";',
    'import { computeTotal, display } from "./cart.js";',
    "",
    'const cart = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));',
    "console.log(display(computeTotal(cart.lines, cart.discount)));",
    "",
  ].join("\n"),
};

// ── Tasks + hidden graders ───────────────────────────────────────────────────

interface Task {
  id: string;
  prompt: string;
  /** Hidden node:test files, copied in only after the agent finished. */
  graders: Readonly<Record<string, string>>;
  /** True when the result matches what the STALE history said. */
  stale: (repo: string) => Promise<boolean>;
  /** Grader self-test: a correct solution (must pass) and a stale-memory one (must fail as stale). */
  reference: Readonly<Record<string, string>>;
  staleAnswer: Readonly<Record<string, string>>;
}

const readOr = async (file: string): Promise<string> => fs.readFile(file, "utf8").catch(() => "");

const TASKS: readonly Task[] = [
  {
    id: "t1-docs",
    prompt:
      "Write docs/limits.md: a markdown table with one row each for MAX_RETRIES and BACKOFF_MS " +
      "showing their current values in the code, followed by the full list of retry delays in ms " +
      "(BACKOFF_MS × 2^attempt for attempt 0 .. MAX_RETRIES-1).",
    graders: {
      "grade-t1.test.js": [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'import fs from "node:fs";',
        'test("limits doc lists the current values", () => {',
        '  const md = fs.readFileSync("docs/limits.md", "utf8");',
        "  assert.match(md, /MAX_RETRIES[^\\n]*\\b5\\b/);",
        "  assert.match(md, /BACKOFF_MS[^\\n]*\\b250\\b/);",
        '  for (const d of ["250", "500", "1,?000", "2,?000", "4,?000"]) assert.match(md, new RegExp(`\\\\b${d}\\\\b`));',
        "});",
        "",
      ].join("\n"),
    },
    stale: async (repo) => {
      const md = await readOr(path.join(repo, "docs/limits.md"));
      return /MAX_RETRIES[^\n]*\b3\b/.test(md) || /BACKOFF_MS[^\n]*\b100\b/.test(md);
    },
    reference: {
      "docs/limits.md":
        "| Setting | Value |\n|---|---|\n| MAX_RETRIES | 5 |\n| BACKOFF_MS | 250 |\n\nRetry delays (ms): 250, 500, 1,000, 2000, 4000\n",
    },
    staleAnswer: {
      "docs/limits.md":
        "| Setting | Value |\n|---|---|\n| MAX_RETRIES | 3 |\n| BACKOFF_MS | 100 |\n\nRetry delays (ms): 100, 200, 400\n",
    },
  },
  {
    id: "t2-bugfix",
    prompt:
      "Customers report cart totals with a percentage discount are sometimes a cent too high: the " +
      "discount should be rounded to the nearest cent (half up), not rounded down. Fix it in the " +
      "cart code and add a regression test to the existing test suite.",
    graders: {
      "grade-t2.test.js": [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'import { spawnSync } from "node:child_process";',
        'import fs from "node:fs";',
        'import { cartTotalCents } from "../src/cart.js";',
        'test("percentage discount rounds half up to the nearest cent", () => {',
        "  assert.equal(cartTotalCents([{ unitCents: 1999, qty: 1 }], 15), 1699);",
        "  assert.equal(cartTotalCents([{ unitCents: 333, qty: 3 }], 50), 499);",
        "  assert.equal(cartTotalCents([{ unitCents: 1000, qty: 3 }], 10), 2700);",
        "  assert.equal(cartTotalCents([{ unitCents: 500, qty: 2 }]), 1000);",
        "});",
        'test("existing suite passes and gained a test", () => {',
        '  const files = fs.readdirSync("test").filter((f) => f.endsWith(".js")).map((f) => `test/${f}`);',
        '  const r = spawnSync(process.execPath, ["--test", ...files], { encoding: "utf8" });',
        "  assert.equal(r.status, 0, r.stdout + r.stderr);",
        '  const src = fs.readdirSync("test").map((f) => fs.readFileSync(`test/${f}`, "utf8")).join("\\n");',
        '  assert.ok((src.match(/\\btest\\(/g) ?? []).length > 3, "no new test case");',
        "});",
        "",
      ].join("\n"),
    },
    stale: async (repo) =>
      /computeTotal|\.quantity\b/.test(await readOr(path.join(repo, "src/cart.js"))),
    reference: {
      "src/cart.js": (FIXTURE["src/cart.js"] ?? "").replace("Math.floor(", "Math.round("),
      "test/cart.test.js": `${FIXTURE["test/cart.test.js"] ?? ""}\ntest("rounds half up", () => {\n  assert.equal(cartTotalCents([{ unitCents: 1999, qty: 1 }], 15), 1699);\n});\n`,
    },
    staleAnswer: {
      "src/cart.js": `${FIXTURE["src/cart.js"] ?? ""}\nexport function computeTotal(lines, discount) {\n  let total = 0;\n  for (const line of lines) total += line.price * line.quantity;\n  return total - Math.round((total * (discount || 0)) / 100);\n}\n`,
    },
  },
  {
    id: "t3-feature",
    prompt:
      'Add a --json flag to the CLI: with it, print only a JSON object {"totalCents": number, ' +
      '"currency": string} for the cart instead of the formatted line. Without the flag the output ' +
      "must stay exactly as it is.",
    graders: {
      "grade-t3.test.js": [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'import { execFileSync } from "node:child_process";',
        'const run = (...a) => execFileSync(process.execPath, ["src/cli.js", "fixtures/cart.json", ...a], { encoding: "utf8" });',
        'test("--json prints the machine-readable total", () => {',
        '  const j = JSON.parse(run("--json"));',
        "  assert.equal(j.totalCents, 3918);",
        '  assert.equal(j.currency, "EUR");',
        "});",
        'test("plain output is unchanged", () => {',
        '  assert.equal(run().trim(), "39.18 EUR");',
        "});",
        "",
      ].join("\n"),
    },
    stale: async (repo) =>
      /["']USD["']|computeTotal|cart\.lines/.test(await readOr(path.join(repo, "src/cli.js"))),
    reference: {
      "src/cli.js": (FIXTURE["src/cli.js"] ?? "")
        .replace(
          'import { cartTotalCents, formatTotal } from "./cart.js";',
          'import { cartTotalCents, formatTotal } from "./cart.js";\nimport { CURRENCY } from "./config.js";',
        )
        .replace(
          "console.log(formatTotal(cartTotalCents(cart.items, cart.discountPct ?? 0)));",
          'const total = cartTotalCents(cart.items, cart.discountPct ?? 0);\nif (process.argv.includes("--json")) console.log(JSON.stringify({ totalCents: total, currency: CURRENCY }));\nelse console.log(formatTotal(total));',
        ),
    },
    staleAnswer: {
      "src/cli.js": (FIXTURE["src/cli.js"] ?? "").replace(
        "console.log(formatTotal(cartTotalCents(cart.items, cart.discountPct ?? 0)));",
        'const total = cartTotalCents(cart.items, cart.discountPct ?? 0);\nif (process.argv.includes("--json")) console.log(JSON.stringify({ totalCents: total, currency: "USD" }));\nelse console.log(formatTotal(total));',
      ),
    },
  },
];

// ── Seeded long-session history ──────────────────────────────────────────────

/** Deterministic list of real engine source files used as earlier exploration. */
function engineSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  };
  for (const pkg of ["gg-ai", "gg-agent", "gg-core", "ggcoder"]) {
    walk(path.join(REPO_ROOT, "packages", pkg, "src"));
  }
  return out;
}

const numbered = (text: string): string =>
  text
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");

/** ~chars per token for TypeScript source on Claude tokenizers (measured ~3.4–3.6). */
const CHARS_PER_TOKEN = 3.5;
const READ_CAP_CHARS = 50_000;

function buildHistory(repo: string, targetTokens: number): Message[] {
  const messages: Message[] = [];
  let callSeq = 0;
  const readTurn = (files: { path: string; text: string }[]): void => {
    const calls = files.map((f) => ({
      type: "tool_call" as const,
      id: `toolu_bench${String(++callSeq).padStart(5, "0")}`,
      name: "read",
      args: { file_path: f.path },
    }));
    messages.push({ role: "assistant", content: calls });
    messages.push({
      role: "tool",
      content: calls.map((c, i) => ({
        type: "tool_result" as const,
        toolCallId: c.id,
        content: numbered(files[i]?.text ?? ""),
      })),
    });
  };

  messages.push({
    role: "user",
    content: `Get familiar with this cart service (${repo}) and with the engine code in ${REPO_ROOT}/packages. We'll work on both over this session.`,
  });
  readTurn(
    ["src/config.js", "src/cart.js", "src/cli.js"].map((rel) => ({
      path: path.join(repo, rel),
      text: STALE[rel] ?? "",
    })),
  );
  messages.push({
    role: "assistant",
    content:
      'The cart service is small: `src/config.js` sets MAX_RETRIES = 3, BACKOFF_MS = 100 and CURRENCY = "USD"; ' +
      "`src/cart.js` has `computeTotal(lines, discount)` (lines have `price` and `quantity`) and `display(total)`; " +
      "`src/cli.js` reads `cart.lines` from the JSON file given as the first argument. I'll look at the engine next.",
  });

  const budgetChars = Math.max(0, targetTokens * CHARS_PER_TOKEN - 20_000);
  let used = 0;
  let round = 0;
  for (const file of engineSourceFiles()) {
    if (used >= budgetChars) break;
    if (round % 3 === 0) {
      messages.push({
        role: "user",
        content: `Next, go through ${path.relative(REPO_ROOT, path.dirname(file))} and note anything relevant.`,
      });
    }
    const text = readFileSync(file, "utf8").slice(0, READ_CAP_CHARS);
    readTurn([{ path: file, text }]);
    messages.push({
      role: "assistant",
      content: `Read ${path.basename(file)} (${text.split("\n").length} lines). Noted its exports and how it is wired in.`,
    });
    used += text.length;
    round++;
  }
  messages.push({ role: "user", content: "Thanks, that's enough exploration for now." });
  messages.push({ role: "assistant", content: "Sounds good. Ready for the next task." });
  return messages;
}

// ── Grading ──────────────────────────────────────────────────────────────────

/** Run the task's hidden tests (copied in only now, after the agent finished). */
async function grade(task: Task, repo: string): Promise<{ ok: boolean; output: string }> {
  await writeFiles(path.join(repo, ".bench-grade"), task.graders);
  // Node 26 treats a bare directory argument as a file, so list the graders.
  const files = Object.keys(task.graders).map((f) => path.join(".bench-grade", f));
  const r = spawnSync(process.execPath, ["--test", ...files], {
    cwd: repo,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-1500) };
}

/** Graders must fail the untouched repo, pass the reference, and flag the stale answer. */
async function selfTest(): Promise<boolean> {
  let allGood = true;
  for (const task of TASKS) {
    const cases: [string, Readonly<Record<string, string>>, boolean, boolean][] = [
      ["untouched", {}, false, false],
      ["reference", task.reference, true, false],
      ["stale", task.staleAnswer, false, true],
    ];
    for (const [name, files, wantOk, wantStale] of cases) {
      const repo = await fs.mkdtemp(path.join(os.tmpdir(), "gg-ctx-selftest-"));
      await writeFiles(repo, FIXTURE);
      await writeFiles(repo, files);
      const { ok, output } = await grade(task, repo);
      const stale = !ok && (await task.stale(repo));
      const good = ok === wantOk && stale === wantStale;
      allGood &&= good;
      console.log(`${good ? "ok  " : "FAIL"} ${task.id} ${name}: pass=${ok} stale=${stale}`);
      if (!good) console.log(output);
      await fs.rm(repo, { recursive: true, force: true });
    }
  }
  return allGood;
}

// ── Child: one run ───────────────────────────────────────────────────────────

interface Job {
  arm: string;
  task: string;
  rep: number;
  model: string;
  historyTokens: number;
  timeoutMs: number;
  dir: string;
}

interface RequestUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RunResult {
  arm: string;
  task: string;
  rep: number;
  ok: boolean;
  stale: boolean;
  error?: string;
  timedOut: boolean;
  wallMs: number;
  turns: number;
  requests: RequestUsage[];
  ttftMs: number[];
  prunes: number;
  pruneFreedTokens: number;
  compactions: number;
  compactionInput: number;
  compactionOutput: number;
  prewarm?: RequestUsage;
  graderOutput: string;
}

function patchSettings(overrides: SettingOverrides): void {
  const effective: SettingOverrides = { ...DEFAULT_SETTINGS, ...overrides };
  const original = SettingsManager.prototype.get;
  const pinned: Partial<Settings> = effective;
  SettingsManager.prototype.get = function patchedGet<K extends keyof Settings>(
    this: SettingsManager,
    key: K,
  ): Settings[K] {
    const value = pinned[key];
    if (Object.hasOwn(pinned, key) && value !== undefined) return value;
    // `.call` drops the method's generic, so restore the key-specific return type.
    return original.call(this, key) as Settings[K];
  };
}

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
  }
}

async function seedSession(
  sessionRoot: string,
  repo: string,
  model: string,
  history: Message[],
): Promise<string> {
  const manager = new SessionManager(sessionRoot);
  const created = await manager.create(repo, PROVIDER, model, { preview: "benchmark history" });
  let parentId: string | null = null;
  const base = Date.UTC(2026, 0, 1);
  for (const [i, message] of history.entries()) {
    const id = crypto.randomUUID();
    await manager.appendEntry(created.path, {
      type: "message",
      id,
      parentId,
      timestamp: new Date(base + i * 1000).toISOString(),
      message,
    });
    parentId = id;
  }
  if (parentId) await manager.updateLeaf(created.path, parentId);
  return created.path;
}

function parseLog(
  text: string,
): Pick<
  RunResult,
  "prunes" | "pruneFreedTokens" | "compactions" | "compactionInput" | "compactionOutput"
> {
  let prunes = 0;
  let pruneFreedTokens = 0;
  let compactions = 0;
  let compactionInput = 0;
  let compactionOutput = 0;
  const num = (line: string, key: string): number =>
    Number(new RegExp(`${key}[=":\\s]+"?(\\d+)`).exec(line)?.[1] ?? 0);
  for (const line of text.split("\n")) {
    if (line.includes("Pruned stale tool outputs")) {
      prunes++;
      pruneFreedTokens += num(line, "freedTokens");
    } else if (line.includes("Summary LLM response received")) {
      compactions++;
      compactionInput += num(line, "inputTokens");
      compactionOutput += num(line, "outputTokens");
    }
  }
  return { prunes, pruneFreedTokens, compactions, compactionInput, compactionOutput };
}

async function collectTtft(sessionRoot: string, sinceMs: number): Promise<number[]> {
  const out: number[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".jsonl")) {
        for (const line of (await readOr(full)).split("\n")) {
          if (!line.includes('"turn_metric"')) continue;
          const parsed: unknown = JSON.parse(line);
          const data = (parsed as { data?: { timing?: { startedAt?: number; ttftMs?: number } } })
            .data;
          const timing = data?.timing;
          if (timing?.ttftMs !== undefined && (timing.startedAt ?? 0) >= sinceMs)
            out.push(timing.ttftMs);
        }
      }
    }
  };
  await walk(sessionRoot);
  return out;
}

async function runChild(job: Job): Promise<RunResult> {
  const arm = ARMS.find((a) => a.id === job.arm);
  const task = TASKS.find((t) => t.id === job.task);
  if (!arm || !task) throw new Error(`unknown arm/task ${job.arm}/${job.task}`);
  patchSettings(arm.settings);

  const repo = path.join(job.dir, "repo");
  const sessionRoot = path.join(job.dir, "sessions");
  await writeFiles(repo, FIXTURE);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync(
    "git",
    ["-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-qm", "init"],
    {
      cwd: repo,
    },
  );
  initLogger(path.join(job.dir, "session.log"));

  const abort = new AbortController();
  const session = new AgentSession({
    provider: PROVIDER,
    model: job.model,
    cwd: repo,
    thinkingLevel: arm.thinking,
    sessionRootDir: sessionRoot,
    deferLoadCompaction: true,
    backgroundMcpConnect: true,
    signal: abort.signal,
    ...(arm.tail ? { getSystemPromptTail: () => REGROUND_TAIL } : {}),
  });
  await session.initialize();
  if (arm.history) {
    const sessionPath = await seedSession(
      sessionRoot,
      repo,
      job.model,
      buildHistory(repo, job.historyTokens),
    );
    await session.loadSession(sessionPath);
  }
  const warm = await session.prewarm();
  const prewarm = warm.usage
    ? {
        input: warm.usage.inputTokens,
        output: warm.usage.outputTokens,
        cacheRead: warm.usage.cacheRead ?? 0,
        cacheWrite: warm.usage.cacheWrite ?? 0,
      }
    : undefined;

  const requests: RequestUsage[] = [];
  let turns = 0;
  session.eventBus.on("turn_end", (e) => {
    requests.push({
      input: e.usage.inputTokens,
      output: e.usage.outputTokens,
      cacheRead: e.usage.cacheRead ?? 0,
      cacheWrite: e.usage.cacheWrite ?? 0,
    });
  });
  session.eventBus.on("agent_done", (e) => {
    turns += e.totalTurns;
  });

  const start = Date.now();
  let timedOut = false;
  let error: string | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, job.timeoutMs);
  try {
    await session.prompt(task.prompt);
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
  } finally {
    clearTimeout(timer);
  }
  const wallMs = Date.now() - start;
  await session.dispose().catch(() => {});
  closeLogger();

  const graded = await grade(task, repo);
  const ok = graded.ok && !timedOut;
  const stale = !ok && (await task.stale(repo));

  return {
    arm: arm.id,
    task: task.id,
    rep: job.rep,
    ok,
    stale,
    ...(error ? { error } : {}),
    timedOut,
    wallMs,
    turns,
    requests,
    ttftMs: await collectTtft(sessionRoot, start),
    ...parseLog(await readOr(path.join(job.dir, "session.log"))),
    ...(prewarm ? { prewarm } : {}),
    graderOutput: graded.output,
  };
}

// ── Parent: schedule, aggregate, report ──────────────────────────────────────

/** Haiku 5.5 list prices, $/MTok (model-registry: $0.10/$0.50 up to 100K prompt, $0.50/$2.50 above). */
function haikuCostUsd(result: RunResult, longCache: boolean): number {
  let usd = 0;
  for (const [i, r] of result.requests.entries()) {
    const prompt = r.input + r.cacheRead + r.cacheWrite;
    const inRate = prompt > 100_000 ? 0.5 : 0.1;
    const outRate = prompt > 100_000 ? 2.5 : 0.5;
    // 1-h writes (2x) only at the opening request; the loop tail is written at 5 min (1.25x).
    const writeMul = longCache && i === 0 ? 2 : 1.25;
    usd +=
      (inRate * (r.input + 0.1 * r.cacheRead + writeMul * r.cacheWrite) + outRate * r.output) / 1e6;
  }
  const big = result.compactionInput > 100_000;
  usd +=
    ((big ? 0.5 : 0.1) * result.compactionInput + (big ? 2.5 : 0.5) * result.compactionOutput) /
    1e6;
  return usd;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : 0);

export function renderReport(results: RunResult[], model: string): string {
  const lines: string[] = [];
  const priced = model === "claude-haiku-5-5";
  lines.push(`# Context-policy benchmark (${model}, ${results.length} runs)`, "");
  lines.push(
    "| Arm | Pass | Stale | Wall p50 | Turns | First word p50 | Prompt p50 | Cache read | Cache write | Output | Est. $/task | Prunes | Compactions |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  const baseline = results.filter((r) => r.arm === "baseline");
  const costOf = (r: RunResult): number =>
    haikuCostUsd(
      r,
      (ARMS.find((a) => a.id === r.arm)?.settings.speedProfile ?? "optimized") === "optimized",
    );
  for (const arm of ARMS) {
    const rs = results.filter((r) => r.arm === arm.id);
    if (rs.length === 0) continue;
    const reqs = rs.flatMap((r) => r.requests);
    const k = (n: number): string => `${(n / 1e3).toFixed(0)}k`;
    lines.push(
      `| ${arm.id} | ${rs.filter((r) => r.ok).length}/${rs.length} | ${rs.filter((r) => r.stale).length} | ` +
        `${(median(rs.map((r) => r.wallMs)) / 1000).toFixed(1)} s | ${mean(rs.map((r) => r.requests.length)).toFixed(1)} | ` +
        `${(median(rs.flatMap((r) => r.ttftMs)) / 1000).toFixed(1)} s | ${k(median(reqs.map((r) => r.input + r.cacheRead + r.cacheWrite)))} | ` +
        `${k(mean(rs.map((r) => sum(r.requests.map((q) => q.cacheRead)))))} | ${k(mean(rs.map((r) => sum(r.requests.map((q) => q.cacheWrite)))))} | ` +
        `${k(mean(rs.map((r) => sum(r.requests.map((q) => q.output)))))} | ${priced ? `$${mean(rs.map(costOf)).toFixed(3)}` : "n/a"} | ` +
        `${sum(rs.map((r) => r.prunes))} | ${sum(rs.map((r) => r.compactions))} |`,
    );
  }
  lines.push("", "Per task (pass/runs):", "");
  lines.push(
    `| Arm | ${TASKS.map((t) => t.id).join(" | ")} |`,
    `|---|${TASKS.map(() => "---").join("|")}|`,
  );
  for (const arm of ARMS) {
    const rs = results.filter((r) => r.arm === arm.id);
    if (rs.length === 0) continue;
    const cells = TASKS.map((t) => {
      const ts = rs.filter((r) => r.task === t.id);
      return `${ts.filter((r) => r.ok).length}/${ts.length}`;
    });
    lines.push(`| ${arm.id} | ${cells.join(" | ")} |`);
  }
  if (baseline.length) {
    lines.push("", "Arms: " + ARMS.map((a) => `**${a.id}** = ${a.label}`).join("; "));
  }
  lines.push(
    "",
    "Notes: wall = prompt to finish (prewarm excluded). Stale = failed AND the result matches the outdated history. " +
      "Cost is a Haiku 5.5 list-price estimate; compaction cache reads are not logged, so compaction cost is input+output only.",
  );
  return lines.join("\n");
}

interface ParentOptions {
  arms: string[];
  tasks: string[];
  reps: number;
  concurrency: number;
  historyTokens: number;
  model: string;
  timeoutMs: number;
  out: string;
}

function parseArgs(
  argv: string[],
): ParentOptions & { report?: string; child?: string; selftest: boolean } {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (name: string, all: readonly { id: string }[]): string[] => {
    const v = get(name);
    const ids = v ? v.split(",") : all.map((x) => x.id);
    for (const id of ids)
      if (!all.some((x) => x.id === id)) throw new Error(`unknown ${name}: ${id}`);
    return ids;
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    arms: list("arms", ARMS),
    tasks: list("tasks", TASKS),
    reps: Number(get("reps") ?? 2),
    concurrency: Number(get("concurrency") ?? 3),
    historyTokens: Number(get("history") ?? 450_000),
    model: get("model") ?? "claude-haiku-5-5",
    timeoutMs: Number(get("timeout-min") ?? 8) * 60_000,
    out: get("out") ?? path.join(os.tmpdir(), "gg-context-bench", stamp),
    ...(get("report") ? { report: get("report") } : {}),
    ...(get("child") ? { child: get("child") } : {}),
    selftest: argv.includes("--selftest"),
  };
}

function runJobInChild(job: Job): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), "--child", JSON.stringify(job)],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => {
      const line = stdout.split("\n").find((l) => l.startsWith("BENCH_RESULT "));
      if (line) {
        resolve(JSON.parse(line.slice("BENCH_RESULT ".length)) as RunResult);
        return;
      }
      resolve({
        arm: job.arm,
        task: job.task,
        rep: job.rep,
        ok: false,
        stale: false,
        error: `child exited ${code}: ${stderr.slice(-400)}`,
        timedOut: false,
        wallMs: 0,
        turns: 0,
        requests: [],
        ttftMs: [],
        prunes: 0,
        pruneFreedTokens: 0,
        compactions: 0,
        compactionInput: 0,
        compactionOutput: 0,
        graderOutput: "",
      });
    });
  });
}

async function readResults(out: string): Promise<RunResult[]> {
  return (await readOr(path.join(out, "results.jsonl")))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunResult);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.child) {
    const result = await runChild(JSON.parse(opts.child) as Job);
    process.stdout.write(`BENCH_RESULT ${JSON.stringify(result)}\n`);
    process.exit(0);
  }
  if (opts.selftest) {
    process.exit((await selfTest()) ? 0 : 1);
  }
  if (opts.report) {
    const results = await readResults(opts.report);
    console.log(renderReport(results, opts.model));
    return;
  }

  await fs.mkdir(opts.out, { recursive: true });
  const jobs: Job[] = [];
  // rep-major order spreads provider-latency drift evenly over the arms
  for (let rep = 0; rep < opts.reps; rep++) {
    for (const task of opts.tasks) {
      for (const arm of opts.arms) {
        jobs.push({
          arm,
          task,
          rep,
          model: opts.model,
          historyTokens: opts.historyTokens,
          timeoutMs: opts.timeoutMs,
          dir: path.join(opts.out, "runs", `${arm}__${task}__${rep}`),
        });
      }
    }
  }
  console.log(`${jobs.length} runs → ${opts.out}`);
  const resultsFile = path.join(opts.out, "results.jsonl");
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (let job = jobs[next++]; job; job = jobs[next++]) {
      const r = await runJobInChild(job);
      await fs.appendFile(resultsFile, `${JSON.stringify(r)}\n`);
      done++;
      console.log(
        `[${done}/${jobs.length}] ${r.arm} ${r.task} #${r.rep}: ${r.ok ? "PASS" : r.stale ? "STALE" : "FAIL"} ` +
          `${(r.wallMs / 1000).toFixed(1)}s req=${r.requests.length} prunes=${r.prunes} compactions=${r.compactions}` +
          (r.error ? ` error=${r.error.slice(0, 120)}` : ""),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()));
  const report = renderReport(await readResults(opts.out), opts.model);
  await fs.writeFile(path.join(opts.out, "report.md"), report);
  console.log(`\n${report}\n\nResults: ${resultsFile}`);
}

const isDirectRun = process.argv[1]?.endsWith("context-policy-benchmark.ts") ?? false;
if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
