#!/usr/bin/env node
// Baseline 01 — EOL-aware edit executor (adoption item #1).
// Measures how often Sonnet 5's edits FAIL on CRLF-encoded files with the
// CURRENT edit tool, and whether CRLF endings survive the edits.
// Run from repo root: node bench/baseline/01-eol-edits.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  SONNET,
  runAgentTask,
  createTools,
  makeTmpDir,
  cleanupDir,
  writeCrlfCorpus,
  writeResult,
  fmt,
  pct,
  table,
} from "./lib.mjs";

const SYSTEM =
  "You are a coding agent. Complete the task with the read/edit tools, then reply DONE.";
const RUNS_PER_TASK = 3;
const TOOL_NAMES = ["read", "edit", "ls"];
const MAX_TURNS = 8;

// lib.mjs's runAgentTask only records arg/result SIZES; this benchmark needs
// the edit tool's error text (for "not found" classification) and, for the
// diagnostic run, the exact old_text/new_text args. So we wrap each tool's
// execute to capture args + result/error text, and let runAgentTask handle
// auth and the agent loop internally.
function wrapTools(tools, captured, { captureArgs = false } = {}) {
  return tools.map((t) => ({
    ...t,
    execute: async (args, ctx) => {
      const rec = { name: t.name, argsChars: JSON.stringify(args ?? {}).length };
      if (captureArgs) rec.args = args;
      captured.push(rec);
      try {
        const out = await t.execute(args, ctx);
        rec.isError = false;
        rec.resultText = typeof out === "string" ? out : String(out?.content ?? "");
        rec.resultChars = rec.resultText.length;
        return out;
      } catch (err) {
        rec.isError = true;
        rec.resultText = err instanceof Error ? err.message : String(err);
        rec.resultChars = rec.resultText.length;
        throw err;
      }
    },
  }));
}

const TASKS = [
  {
    id: "mul-plus-one",
    file: "src/math.ts",
    prompt: "In src/math.ts, change the mul function to return a * b + 1 instead of a * b.",
    check: (c) => c.includes("return a * b + 1;"),
  },
  {
    id: "rename-trimmed",
    file: "src/greet.ts",
    prompt:
      "In src/greet.ts, rename the local variable `trimmed` to `cleaned` (both occurrences).",
    check: (c) => !/\btrimmed\b/.test(c) && (c.match(/\bcleaned\b/g) ?? []).length >= 2,
  },
  {
    id: "retries-5",
    file: "src/config.ts",
    prompt: "In src/config.ts, change retries from 3 to 5.",
    check: (c) => c.includes("retries: 5"),
  },
  {
    id: "readme-heading",
    file: "README.md",
    prompt: 'In README.md, change the top-level heading to "# CRLF Fixture".',
    check: (c) => c.includes("# CRLF Fixture"),
  },
  {
    id: "add-div",
    file: "src/math.ts",
    prompt:
      "In src/math.ts, add an exported function `div` (a: number, b: number): number that returns a / b, placed after the mul function.",
    check: (c) => /export function div/.test(c),
  },
  {
    id: "farewell-trimmed",
    file: "src/greet.ts",
    prompt:
      "In src/greet.ts, change the farewell function to use the trimmed name too (trim the name the same way greet does).",
    check: (c) => {
      const i = c.indexOf("export function farewell");
      return i >= 0 && c.slice(i).includes("trimmed");
    },
  },
];

function crlfSurvives(content) {
  if (!content.includes("\r\n")) return false;
  const stripped = content.replace(/\r\n/g, "");
  return !stripped.includes("\n") && !stripped.includes("\r");
}

const isNotFound = (s) => /not found/i.test(s ?? "");

async function oneRun(task, runIdx, { captureArgs = false } = {}) {
  const dir = await makeTmpDir("eol");
  try {
    await writeCrlfCorpus(dir);
    const { tools } = await createTools(dir, { model: SONNET, lspDiagnostics: false });
    const captured = [];
    const useTools = wrapTools(
      tools.filter((t) => TOOL_NAMES.includes(t.name)),
      captured,
      { captureArgs },
    );
    const res = await runAgentTask({
      system: SYSTEM,
      prompt: task.prompt,
      tools: useTools,
      maxTurns: MAX_TURNS,
      maxTokens: 4096,
      thinking: "low",
    });
    res.toolCalls = captured;

    const content = await readFile(path.join(dir, task.file), "utf8");
    const success = task.check(content);
    const survived = crlfSurvives(content);
    const editCalls = res.toolCalls.filter((c) => c.name === "edit");
    const failedEdits = editCalls.filter((c) => c.isError);
    const notFound = failedEdits.filter((c) => isNotFound(c.resultText));

    return {
      task: task.id,
      run: runIdx,
      success,
      crlfSurvived: survived,
      toolCalls: captured.length,
      editCalls: editCalls.length,
      failedEditCalls: failedEdits.length,
      notFoundErrors: notFound.length,
      error: res.error,
      llmCalls: res.llmCalls,
      wallMs: res.wallMs,
      usage: res.usage,
      _toolCalls: captureArgs ? captured : undefined,
    };
  } finally {
    await cleanupDir(dir);
  }
}

console.log(`Baseline 01: EOL edits on CRLF corpus — ${TASKS.length} tasks × ${RUNS_PER_TASK} runs`);
const runs = [];
for (const task of TASKS) {
  for (let r = 1; r <= RUNS_PER_TASK; r++) {
    const run = await oneRun(task, r);
    runs.push(run);
    console.log(
      `  ${task.id} #${r}: ${run.success ? "OK" : "FAIL"} | edits ${run.failedEditCalls}/${run.editCalls} failed` +
        ` (${run.notFoundErrors} not-found) | crlf ${run.crlfSurvived ? "intact" : "CORRUPTED"} | ${run.llmCalls} llm calls | ${(run.wallMs / 1000).toFixed(0)}s`,
    );
  }
}

// ── Diagnostic run: capture exact edit args on a failing edit ──
console.log("\nDiagnostic run (mul-plus-one, capturing edit args)…");
const diag = await oneRun(TASKS[0], 0, { captureArgs: true });
const diagFail = (diag._toolCalls ?? []).find((c) => c.name === "edit" && c.isError);
let diagnostic;
if (diagFail) {
  const editArgs = diagFail.args?.edits?.[0] ?? diagFail.args ?? {};
  diagnostic = {
    task: diag.task,
    old_text: editArgs.old_text ?? null,
    new_text: editArgs.new_text ?? null,
    resultText: diagFail.resultText?.slice(0, 2000) ?? null,
  };
  console.log("Failing edit args (diagnostic):");
  console.log("  old_text:", JSON.stringify(diagnostic.old_text));
  console.log("  new_text:", JSON.stringify(diagnostic.new_text));
  console.log("  result:", diagnostic.resultText?.split("\n")[0]);
} else {
  diagnostic = { task: diag.task, note: "no failing edit observed in diagnostic run", success: diag.success };
  console.log(`  ${diagnostic.note} (success=${diag.success})`);
}

// ── Summary ──
const totalRuns = runs.length;
const successes = runs.filter((r) => r.success).length;
const totalEdits = runs.reduce((a, r) => a + r.editCalls, 0);
const failedEdits = runs.reduce((a, r) => a + r.failedEditCalls, 0);
const notFoundErrors = runs.reduce((a, r) => a + r.notFoundErrors, 0);
const crlfCorrupted = runs.filter((r) => !r.crlfSurvived).length;

const summary = {
  totalRuns,
  successRate: fmt(pct(successes, totalRuns), 1) + "%",
  editErrorRate: fmt(pct(failedEdits, totalEdits), 1) + "%",
  totalEditCalls: totalEdits,
  failedEditCalls: failedEdits,
  notFoundErrors,
  crlfCorrupted,
};

console.log("\nPer-run results:");
table(
  runs.map((r) => [
    r.task,
    r.run,
    r.success ? "OK" : "FAIL",
    `${r.failedEditCalls}/${r.editCalls}`,
    r.notFoundErrors,
    r.crlfSurvived ? "intact" : "CORRUPTED",
    r.llmCalls,
    (r.wallMs / 1000).toFixed(0) + "s",
  ]),
  ["task", "run", "success", "editFail", "notFound", "crlf", "llm", "wall"],
);
console.log("\nSummary:");
table(
  [
    ["success rate", summary.successRate],
    ["edit error rate", `${summary.editErrorRate} (${failedEdits}/${totalEdits})`],
    ["not-found errors", notFoundErrors],
    ["CRLF corrupted runs", `${crlfCorrupted}/${totalRuns}`],
  ],
  ["metric", "value"],
);

writeResult("01-eol-edits", {
  runs: runs.map(({ _toolCalls, ...r }) => r),
  diagnostic,
  summary,
});
