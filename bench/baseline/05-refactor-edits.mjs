#!/usr/bin/env node
// Baseline 05 — semantic refactors with CURRENT text-based edit tools
// (the bar an lsp_rename / lsp_replace_symbol tool must beat; adoption item #16).
// Run from repo root: node bench/baseline/05-refactor-edits.mjs
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  SONNET,
  REPO_ROOT,
  runAgentTask,
  createTools,
  makeTmpDir,
  cleanupDir,
  writeResult,
  mean,
  fmt,
  pct,
  table,
} from "./lib.mjs";

const execFileP = promisify(execFile);
const TSC = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");

const SYSTEM =
  "You are a coding agent working in the current directory. Complete the refactoring task " +
  "with the read/edit/grep/find/ls tools, making sure the project still compiles, then reply DONE.";
const RUNS_PER_TASK = 3;
const TOOL_NAMES = ["read", "edit", "grep", "find", "ls"]; // no bash
const MAX_TURNS = 20;

// ── Fixture ────────────────────────────────────────────────

const FIXTURE = {
  "src/util.ts": `export function formatName(first: string, last: string): string {
  return \`\${first} \${last}\`.trim();
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
`,
  "src/api.ts": `import { formatName } from "./util";

export function renderUser(first: string, last: string): string {
  const full = formatName(first, last);
  const banner = \`User: \${formatName(first, last)}\`;
  const footer = formatName(first, last).toUpperCase();
  return [banner, full, footer].join("\\n");
}
`,
  "src/cli.ts": `import { formatName, slugify } from "./util";

export function main(argv: string[]): string {
  const name = formatName(argv[0] ?? "ada", argv[1] ?? "lovelace");
  return \`\${name} -> \${slugify(name)}\`;
}
`,
  "src/util.test.ts": `import { formatName, slugify } from "./util";

function assertEq(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(\`expected \${expected}, got \${actual}\`);
}

export function runTests(): void {
  assertEq(formatName("Ada", "Lovelace"), "Ada Lovelace");
  assertEq(slugify("Hello, World!"), "hello-world");
}
`,
  "src/config.ts": `export const MAX_RETRIES = 3;
export const TIMEOUT_MS = 5000;
export const VERBOSE = false;
`,
  "src/worker.ts": `import { MAX_RETRIES } from "./config";

export function attempt<T>(fn: () => T): T {
  let lastErr: unknown;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
`,
  "README.md": `# Refactor Fixture

A tiny TypeScript project. Users are rendered with a formatted display name
(the formatName helper) and pages get URL slugs.
`,
};

const TSCONFIG = {
  compilerOptions: {
    strict: true,
    target: "es2022",
    module: "esnext",
    moduleResolution: "bundler",
    noEmit: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
  },
  include: ["src/**/*.ts"],
};

async function writeFixture(dir) {
  await mkdir(path.join(dir, "src"), { recursive: true });
  for (const [rel, content] of Object.entries(FIXTURE)) {
    await writeFile(path.join(dir, rel), content, "utf8");
  }
  await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG, null, 2), "utf8");
}

async function readTsFiles(dir) {
  const out = {};
  const srcDir = path.join(dir, "src");
  let entries = [];
  try {
    entries = await readdir(srcDir);
  } catch {
    return out;
  }
  for (const f of entries) {
    if (f.endsWith(".ts")) {
      out[`src/${f}`] = await readFile(path.join(srcDir, f), "utf8");
    }
  }
  return out;
}

async function compiles(dir) {
  try {
    await execFileP(TSC, ["-p", "."], { cwd: dir, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, output: "" };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}`.slice(0, 2000) };
  }
}

// ── Tasks ──────────────────────────────────────────────────

const wordRe = (ident) => new RegExp(`\\b${ident}\\b`);

const TASKS = [
  {
    id: "rename-formatName",
    prompt:
      "Rename the function `formatName` to `formatDisplayName` everywhere in the TypeScript code " +
      "(all .ts files under src/: definition, imports, and every call site). Do not change README.md.",
    oldIdent: "formatName",
    expectNew: {
      "src/util.ts": "formatDisplayName",
      "src/api.ts": "formatDisplayName",
      "src/cli.ts": "formatDisplayName",
      "src/util.test.ts": "formatDisplayName",
    },
  },
  {
    id: "rename-slugify",
    prompt:
      "Rename the function `slugify` to `toSlug` everywhere in the TypeScript code, " +
      "including its test file. Do not change README.md.",
    oldIdent: "slugify",
    expectNew: {
      "src/util.ts": "toSlug",
      "src/cli.ts": "toSlug",
      "src/util.test.ts": "toSlug",
    },
  },
  {
    id: "move-slugify",
    prompt:
      "Move the function `slugify` from src/util.ts into a new file src/strings.ts (exported from there), " +
      "and update all imports so the project still compiles. Keep the function name `slugify`.",
    oldIdent: null,
    // The edit tool cannot create files, and this task requires creating
    // src/strings.ts — grant the write tool for this task only.
    extraTools: ["write"],
    custom: (files) => {
      const problems = [];
      if (/export function slugify/.test(files["src/util.ts"] ?? "")) {
        problems.push("src/util.ts still defines slugify");
      }
      if (files["src/strings.ts"] === undefined) {
        problems.push("src/strings.ts was not created");
      } else if (!/export function slugify/.test(files["src/strings.ts"])) {
        problems.push("src/strings.ts does not export slugify");
      }
      return problems;
    },
  },
  {
    id: "rename-max-retries",
    prompt:
      "Rename the exported constant `MAX_RETRIES` in src/config.ts to `MAX_ATTEMPTS` and update " +
      "every file that references it.",
    oldIdent: "MAX_RETRIES",
    expectNew: {
      "src/config.ts": "MAX_ATTEMPTS",
      "src/worker.ts": "MAX_ATTEMPTS",
    },
  },
];

async function verify(dir, task) {
  const files = await readTsFiles(dir);
  const problems = [];
  let missedRefFiles = 0;

  if (task.oldIdent) {
    const re = wordRe(task.oldIdent);
    for (const [rel, content] of Object.entries(files)) {
      if (re.test(content)) {
        problems.push(`${rel} still references ${task.oldIdent}`);
        missedRefFiles++;
      }
    }
    for (const [rel, ident] of Object.entries(task.expectNew)) {
      if (!wordRe(ident).test(files[rel] ?? "")) {
        problems.push(`${rel} missing ${ident}`);
        missedRefFiles++;
      }
    }
  } else if (task.custom) {
    const ps = task.custom(files);
    problems.push(...ps);
    missedRefFiles += ps.length;
  }

  const tsc = await compiles(dir);
  if (!tsc.ok) problems.push(`tsc failed: ${tsc.output.split("\n")[0] ?? ""}`);

  return { success: problems.length === 0, problems, missedRefFiles, compileOk: tsc.ok };
}

// Wrap each tool's execute to capture per-call isError/result text (lib's
// runAgentTask keeps only sizes); runAgentTask handles auth + the agent loop.
function wrapTools(tools, captured) {
  return tools.map((t) => ({
    ...t,
    execute: async (args, ctx) => {
      const rec = { name: t.name, argsChars: JSON.stringify(args ?? {}).length };
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

// ── Main ───────────────────────────────────────────────────

// Sanity: the pristine fixture must compile before we measure anything.
{
  const dir = await makeTmpDir("refactor-sanity");
  await writeFixture(dir);
  const tsc = await compiles(dir);
  await cleanupDir(dir);
  if (!tsc.ok) {
    console.error("Fixture does not compile out of the box — aborting.\n" + tsc.output);
    process.exit(1);
  }
  console.log("Fixture compiles cleanly (tsc --noEmit).");
}

console.log(`Baseline 05: refactor edits — ${TASKS.length} tasks × ${RUNS_PER_TASK} runs`);
const runs = [];
for (const task of TASKS) {
  for (let r = 1; r <= RUNS_PER_TASK; r++) {
    const dir = await makeTmpDir("refactor");
    let rec;
    try {
      await writeFixture(dir);
      const { tools } = await createTools(dir, { model: SONNET, lspDiagnostics: false });
      const captured = [];
      const names = new Set([...TOOL_NAMES, ...(task.extraTools ?? [])]);
      const useTools = wrapTools(
        tools.filter((t) => names.has(t.name)),
        captured,
      );
      const res = await runAgentTask({
        system: SYSTEM,
        prompt: task.prompt,
        tools: useTools,
        maxTurns: MAX_TURNS,
        maxTokens: 4096,
        thinking: "low",
      });
      const v = await verify(dir, task);
      const editCalls = captured.filter((c) => c.name === "edit");
      rec = {
        task: task.id,
        run: r,
        success: v.success,
        compileOk: v.compileOk,
        missedRefFiles: v.missedRefFiles,
        problems: v.problems,
        editCalls: editCalls.length,
        editErrors: editCalls.filter((c) => c.isError).length,
        toolCalls: captured.length,
        llmCalls: res.llmCalls,
        wallMs: res.wallMs,
        usage: res.usage,
        totalTokens: res.usage.inputTokens + res.usage.outputTokens,
        error: res.error,
      };
    } finally {
      await cleanupDir(dir);
    }
    runs.push(rec);
    console.log(
      `  ${rec.task} #${r}: ${rec.success ? "OK" : "FAIL"} | compile ${rec.compileOk ? "ok" : "BROKEN"}` +
        ` | missed ${rec.missedRefFiles} | editErr ${rec.editErrors} | ${rec.llmCalls} llm | ${(rec.wallMs / 1000).toFixed(0)}s` +
        (rec.problems.length ? ` | ${rec.problems[0]}` : ""),
    );
  }
}

const totalRuns = runs.length;
const successes = runs.filter((r) => r.success).length;
const perTask = TASKS.map((t) => {
  const rs = runs.filter((r) => r.task === t.id);
  return {
    task: t.id,
    runs: rs.length,
    successes: rs.filter((r) => r.success).length,
    successRate: fmt(pct(rs.filter((r) => r.success).length, rs.length), 1) + "%",
    meanLlmCalls: fmt(mean(rs.map((r) => r.llmCalls)), 1),
    meanWallS: fmt(mean(rs.map((r) => r.wallMs)) / 1000, 0),
    meanTokens: fmt(mean(rs.map((r) => r.totalTokens)), 0),
    editErrors: rs.reduce((a, r) => a + r.editErrors, 0),
    missedRefFiles: rs.reduce((a, r) => a + r.missedRefFiles, 0),
  };
});

const summary = {
  totalRuns,
  successRate: fmt(pct(successes, totalRuns), 1) + "%",
  perTask,
  meanLlmCalls: fmt(mean(runs.map((r) => r.llmCalls)), 1),
  meanWallS: fmt(mean(runs.map((r) => r.wallMs)) / 1000, 0),
  totalTokens: runs.reduce((a, r) => a + r.totalTokens, 0),
  editErrors: runs.reduce((a, r) => a + r.editErrors, 0),
  missedRefFiles: runs.reduce((a, r) => a + r.missedRefFiles, 0),
  compileFailures: runs.filter((r) => !r.compileOk).length,
  note: "Toolset was read+edit+grep+find+ls (no bash); move-slugify additionally got the write tool because the current edit tool cannot create src/strings.ts.",
};

console.log("\nPer-task summary:");
table(
  perTask.map((p) => [
    p.task,
    p.successRate,
    p.meanLlmCalls,
    p.meanWallS + "s",
    p.meanTokens,
    p.editErrors,
    p.missedRefFiles,
  ]),
  ["task", "success", "llm", "wall", "tokens", "editErr", "missedRefs"],
);
console.log(`\nOverall success rate: ${summary.successRate} (${successes}/${totalRuns})`);
console.log(`Total tokens: ${summary.totalTokens}, edit errors: ${summary.editErrors}, compile failures: ${summary.compileFailures}`);

writeResult("05-refactor-edits", { runs, summary });
