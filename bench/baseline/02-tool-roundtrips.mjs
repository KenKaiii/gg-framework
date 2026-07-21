// Baseline 02 — multi-tool task round-trips (baseline for item #6 tool_script).
//
// Measures the CURRENT cost (tokens, LLM round-trips, wall time) of multi-tool
// tasks with Sonnet 5 — the number a programmatic tool-orchestration feature
// must beat. 5 tasks × 3 runs, fresh fixture per run, success verified
// against ground truth computed from the fixture.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  SONNET,
  createTools,
  runAgentTask,
  makeTmpDir,
  cleanupDir,
  writeWideTree,
  writeResult,
  mean,
  fmt,
  pct,
  table,
} from "./lib.mjs";

const DIRS = 10;
const FILES_PER_DIR = 20;
const RUNS = 3;
const SYSTEM = "You are a coding agent. Complete the task using tools, then give the final answer.";
const TOOL_SET = ["read", "grep", "find", "ls", "edit", "write"];

// Ground truth from the fixture generator: pkg-XXX/file-Y.ts contains
// `export const vX_Y = <X*FILES_PER_DIR+Y>;`
const value = (d, f) => d * FILES_PER_DIR + f;

async function buildFixture() {
  const dir = await makeTmpDir("roundtrips");
  await writeWideTree(dir, { dirs: DIRS, filesPerDir: FILES_PER_DIR });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" }, null, 2) + "\n",
  );
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src/index.ts"), `export const entry = true;\n`);
  return dir;
}

async function grepTree(dir, needle) {
  // Recursively search fixture for a substring (verification only).
  const hits = [];
  async function walk(d) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if ((await readFile(p, "utf8")).includes(needle)) hits.push(p);
    }
  }
  await walk(dir);
  return hits;
}

// Expected answers (computed from the fixture generator):
// 1) pkg-003 values are 60..79 → odd values at odd f → 10 files.
// 2) value === 42 → d=2, f=2 → pkg-002/file-2.ts only.
// 3) value(1,0)+value(5,10)+value(9,19) = 20 + 110 + 199 = 329.
const TASKS = [
  {
    id: "count-odd-exports",
    prompt:
      "Count how many files under pkg-003 export a constant whose value is an odd number. " +
      "Report just the count in your final answer.",
    verify: async (dir, text) => /\b10\b/.test(text),
    expected: "10 files",
  },
  {
    id: "find-value-42",
    prompt:
      "Find every file whose exported constant equals 42 and list their paths in your final answer.",
    verify: async (dir, text) => /pkg-002/.test(text) && /file-2\.ts/.test(text),
    expected: "pkg-002/file-2.ts",
  },
  {
    id: "sum-three-files",
    prompt:
      "Read pkg-001/file-0.ts, pkg-005/file-10.ts, and pkg-009/file-19.ts and report the sum " +
      "of their exported values in your final answer.",
    verify: async (dir, text) => /\b329\b/.test(text),
    expected: "329",
  },
  {
    id: "rename-constant",
    prompt:
      "Rename the exported constant in pkg-002/file-5.ts from v2_5 to ANSWER, then verify no " +
      "other file in the tree references v2_5. Report what you did.",
    verify: async (dir) => {
      const content = await readFile(path.join(dir, "pkg-002", "file-5.ts"), "utf8");
      if (!content.includes(`export const ANSWER = ${value(2, 5)};`)) return false;
      const refs = await grepTree(dir, "v2_5");
      return refs.length === 0;
    },
    expected: "pkg-002/file-5.ts edited, zero v2_5 refs remain",
  },
  {
    id: "write-summary",
    prompt:
      "Create a summary.md (in the current directory) listing how many files each pkg-00X " +
      "directory contains. List every pkg-00X directory.",
    verify: async (dir) => {
      let content;
      try {
        content = await readFile(path.join(dir, "summary.md"), "utf8");
      } catch {
        return false;
      }
      for (let d = 0; d < DIRS; d++) {
        if (!content.includes(`pkg-${String(d).padStart(3, "0")}`)) return false;
      }
      return /\b20\b/.test(content);
    },
    expected: "summary.md with all 10 dirs × 20 files",
  },
];

const runs = [];
for (const task of TASKS) {
  for (let run = 0; run < RUNS; run++) {
    const dir = await buildFixture();
    try {
      const { tools: allTools } = await createTools(dir, { model: SONNET, lspDiagnostics: false });
      const tools = allTools.filter((t) => TOOL_SET.includes(t.name));
      const r = await runAgentTask({ system: SYSTEM, prompt: task.prompt, tools, maxTurns: 15, thinking: "low" });
      const success = !r.error && (await task.verify(dir, r.text));
      runs.push({
        task: task.id,
        run: run + 1,
        success,
        llmCalls: r.llmCalls,
        toolCalls: r.toolCalls.length,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        cacheRead: r.usage.cacheRead,
        cacheWrite: r.usage.cacheWrite,
        wallMs: r.wallMs,
        error: r.error,
        finalText: r.text.slice(0, 300),
      });
      console.log(
        `[${task.id}] run ${run + 1}: ${success ? "OK " : "FAIL"} llmCalls=${r.llmCalls} tools=${r.toolCalls.length} wall=${fmt(r.wallMs / 1000, 1)}s${r.error ? ` err=${r.error}` : ""}`,
      );
    } finally {
      await cleanupDir(dir);
    }
  }
}

const totalTokens = (r) => r.inputTokens + r.outputTokens + r.cacheWrite;
const summarize = (rs) => ({
  n: rs.length,
  successRate: pct(rs.filter((r) => r.success).length, rs.length) / 100,
  avgLlmCalls: mean(rs.map((r) => r.llmCalls)),
  avgToolCalls: mean(rs.map((r) => r.toolCalls)),
  avgInputTokens: mean(rs.map((r) => r.inputTokens)),
  avgOutputTokens: mean(rs.map((r) => r.outputTokens)),
  avgCacheRead: mean(rs.map((r) => r.cacheRead)),
  avgCacheWrite: mean(rs.map((r) => r.cacheWrite)),
  avgTotalTokens: mean(rs.map(totalTokens)), // input+output+cacheWrite; cacheRead noted separately
  avgWallMs: mean(rs.map((r) => r.wallMs)),
});

const perTask = TASKS.map((t) => ({ task: t.id, expected: t.expected, ...summarize(runs.filter((r) => r.task === t.id)) }));
const overall = summarize(runs);

console.log("\n── Per-run ──");
table(
  runs.map((r) => [
    r.task, r.run, r.success ? "ok" : "FAIL", r.llmCalls, r.toolCalls,
    r.inputTokens, r.outputTokens, r.cacheRead, r.cacheWrite, fmt(r.wallMs / 1000, 1) + "s",
  ]),
  ["task", "run", "ok", "llmCalls", "toolCalls", "input", "output", "cacheRead", "cacheWrite", "wall"],
);
console.log("\n── Per-task averages ──");
table(
  perTask.map((t) => [
    t.task, fmt(t.successRate * 100) + "%", fmt(t.avgLlmCalls, 1), fmt(t.avgToolCalls, 1),
    fmt(t.avgTotalTokens), fmt(t.avgCacheRead), fmt(t.avgWallMs / 1000, 1) + "s",
  ]),
  ["task", "success", "llmCalls", "toolCalls", "totalTok*", "cacheRead", "wall"],
);
console.log("* totalTok = input + output + cacheWrite (cacheRead billed separately, shown in its own column)");
console.log(
  `\nOVERALL: success=${fmt(overall.successRate * 100)}% llmCalls=${fmt(overall.avgLlmCalls, 1)} toolCalls=${fmt(overall.avgToolCalls, 1)} totalTok=${fmt(overall.avgTotalTokens)} cacheRead=${fmt(overall.avgCacheRead)} wall=${fmt(overall.avgWallMs / 1000, 1)}s`,
);

writeResult("02-tool-roundtrips", {
  config: { dirs: DIRS, filesPerDir: FILES_PER_DIR, runs: RUNS, maxTurns: 15, thinking: "low", tools: TOOL_SET },
  tasks: TASKS.map((t) => ({ id: t.id, prompt: t.prompt, expected: t.expected })),
  runs,
  perTask,
  overall,
  notes: "totalTokens = input+output+cacheWrite; cacheRead reported separately (cheap re-reads).",
});
process.exit(0);
