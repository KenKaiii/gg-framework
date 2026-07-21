// Baseline 03 — tool-result bytes per turn (baseline for item #2 aggregate
// tool-response budget).
//
// Runs fat-tool-result tasks against a 1000-file tree and measures the
// aggregate tool-result chars PER TURN, then asks: how often would a
// hypothetical aggregate batch budget (10k/25k/50k/100k chars) trigger?
//
// Turn attribution: lib.mjs's runAgentTask records tool calls and turns
// separately, so we re-implement its event loop locally (same body, plus a
// `turn` index on every tool call = number of turn_end events seen so far).
import {
  SONNET,
  Agent,
  anthropicCreds,
  createTools,
  freshCacheKey,
  makeTmpDir,
  cleanupDir,
  writeWideTree,
  writeResult,
  mean,
  fmt,
  pct,
  table,
} from "./lib.mjs";

const DIRS = 20;
const FILES_PER_DIR = 50;
const RUNS = 2;
const SYSTEM = "You are a coding agent. Complete the task using tools, then give the final answer.";
const TOOL_SET = ["read", "grep", "find", "ls"];
const BUDGETS = [10_000, 25_000, 50_000, 100_000];

// ── Local copy of lib.mjs runAgentTask with per-turn attribution ──
async function runAgentTaskPerTurn({ system, prompt, tools, maxTurns = 10, maxTokens = 4096, thinking = "low" }) {
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
          turn: turns.length, // tool calls happen AFTER the assistant turn that requested them
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
  return { text: text.trim(), turns, toolCalls, wallMs: Date.now() - t0, error };
}

const TASKS = [
  {
    id: "grep-padding",
    prompt: "grep for 'padding' across the whole tree and summarize what you find.",
  },
  {
    id: "find-and-read",
    prompt: "Find all .ts files under the pkg-01* directories and read the first 5 of them, then summarize what they contain.",
  },
  {
    id: "count-per-dir",
    prompt: "List every directory in this project and count the files in each.",
  },
];

const runs = [];
for (const task of TASKS) {
  for (let run = 0; run < RUNS; run++) {
    const dir = await makeTmpDir("result-bytes");
    try {
      await writeWideTree(dir, { dirs: DIRS, filesPerDir: FILES_PER_DIR });
      const { tools: allTools } = await createTools(dir, { model: SONNET, lspDiagnostics: false });
      const tools = allTools.filter((t) => TOOL_SET.includes(t.name));
      const r = await runAgentTaskPerTurn({ system: SYSTEM, prompt: task.prompt, tools, maxTurns: 10, thinking: "low" });

      // Per-turn aggregate tool-result chars.
      const perTurn = new Map();
      for (const tc of r.toolCalls) {
        perTurn.set(tc.turn, (perTurn.get(tc.turn) ?? 0) + (tc.resultChars ?? 0));
      }
      const turnAgg = [...perTurn.entries()].map(([turn, chars]) => ({ turn, chars }));
      runs.push({
        task: task.id,
        run: run + 1,
        error: r.error,
        llmCalls: r.turns.length,
        toolCalls: r.toolCalls.length,
        wallMs: r.wallMs,
        turnAgg,
        toolCallSizes: r.toolCalls.map((tc) => ({ name: tc.name, turn: tc.turn, resultChars: tc.resultChars ?? 0 })),
        maxTurnAgg: Math.max(0, ...turnAgg.map((t) => t.chars)),
      });
      console.log(
        `[${task.id}] run ${run + 1}: turns=${r.turns.length} tools=${r.toolCalls.length} maxTurnAgg=${fmt(Math.max(0, ...turnAgg.map((t) => t.chars)))} chars wall=${fmt(r.wallMs / 1000, 1)}s${r.error ? ` err=${r.error}` : ""}`,
      );
    } finally {
      await cleanupDir(dir);
    }
  }
}

// ── Distribution over ALL runs ──
const allTurnAggs = runs.flatMap((r) => r.turnAgg.map((t) => t.chars));
const allResults = runs.flatMap((r) => r.toolCallSizes.map((t) => t.resultChars));
const sorted = [...allTurnAggs].sort((a, b) => a - b);
const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] : 0;

const distribution = {
  turns: allTurnAggs.length,
  individualResults: allResults.length,
  perTurnAggChars: { max: Math.max(0, ...allTurnAggs), mean: mean(allTurnAggs), p95 },
  perResultChars: { max: Math.max(0, ...allResults), mean: mean(allResults) },
};

const budgetTriggers = {};
for (const b of BUDGETS) {
  budgetTriggers[b] = {
    turnsExceeding: allTurnAggs.filter((c) => c > b).length,
    turnsExceedingPct: pct(allTurnAggs.filter((c) => c > b).length, allTurnAggs.length),
    individualResultsExceeding: allResults.filter((c) => c > b).length,
  };
}

// ── Current cap behavior (from reading the source) ──
// packages/gg-agent/src/agent-loop.ts:
//   capToolResults(toolResults, max)        — per-result cap, keeps 70% head + 30% tail,
//                                             inserts "[... N characters omitted ...]"; hard ceiling 400_000 chars.
//   capTurnToolResults(toolResults, max)    — aggregate per-turn budget, water-filling
//                                             (smallest-first fair-share) truncation.
//   Both are invoked on the toolResults array BEFORE it is pushed into the
//   persistent `messages` context (agent-loop.ts:1350
//   `messages.push({ role: "tool", content: executionResult.toolResults })`).
//   The tool_call_end EVENT (agent-loop.ts:1594) is emitted earlier with the
//   FULL result preview — so capping mutates the recorded provider-bound
//   transcript (the messages re-sent to the model on later turns), while the
//   UI/event stream retains the uncapped result. Transcript and wire payload
//   DIVERGE once a cap triggers.
// packages/ggcoder/src/core/agent-session.ts:
//   resolveSessionToolResultCharLimit  = getToolResultCharLimit(model) ?? floor(contextWindow * 3.5 * 0.30)
//   resolveSessionTurnToolResultCharLimit = clamp(floor(contextWindow * 3.5 * 0.15), 100_000, 240_000)
// In THIS bench harness, Agent is constructed without either option, so both
// caps are DISABLED (capToolResults/capTurnToolResults return early on undefined).
let resolvedCaps = {};
try {
  const sess = await import("../../packages/ggcoder/dist/core/agent-session.js");
  resolvedCaps = {
    // getContextWindow is not exported from either dist entry; 1_050_000 /
    // (3.5 * 0.30) implies a 1M-token context window for claude-sonnet-5.
    contextWindow: 1_000_000,
    contextWindowNote: "inferred: perResultChars / (3.5 * 0.30) = 1M tokens",
    perResultChars: sess.resolveSessionToolResultCharLimit?.(SONNET, "anthropic") ?? null,
    perTurnChars: sess.resolveSessionTurnToolResultCharLimit?.(SONNET, "anthropic") ?? null,
  };
} catch (err) {
  resolvedCaps = { error: String(err?.message ?? err) };
}

const currentCaps = {
  agentLoopDefaults: {
    perResultOptionDefault: "undefined → cap OFF in raw Agent; overflow-retry path falls back to 100_000",
    perResultHardCeiling: 400_000,
    perTurnOptionDefault: "undefined → cap OFF in raw Agent",
    benchHarness: "Agent built without maxToolResultChars/maxTurnToolResultChars → both caps disabled in these runs",
  },
  ggcoderSession: {
    formula: {
      perResult: "getToolResultCharLimit(model) ?? floor(contextWindow * 3.5 * 0.30)",
      perTurn: "clamp(floor(contextWindow * 3.5 * 0.15), 100_000, 240_000)",
    },
    resolvedForSonnet5: resolvedCaps,
  },
};

const transcriptDivergence =
  "Capping MUTATES the recorded transcript, not just the outbound payload: capToolResults/capTurnToolResults " +
  "rewrite toolResult.content in place in the array that is then pushed into the persistent `messages` " +
  "context (agent-loop.ts messages.push({role:'tool', content: toolResults})), so all subsequent turns " +
  "re-send the truncated version. However the tool_call_end event is emitted BEFORE capping with the full " +
  "result preview, so the UI/event transcript keeps the untruncated result — the event transcript and the " +
  "provider-bound message history diverge once a cap triggers. " +
  "POST Fix D: capToolResults/capTurnToolResults now stamp a `ToolResult.capped = { originalChars, keptChars, " +
  "scope }` marker whenever they trim, so the divergence is programmatically visible — a consumer can reconcile " +
  "the full tool_call_end preview against the trimmed model input. The marker is internal metadata; the wire " +
  "serializers (toAnthropicMessages/toOpenAIMessages) pick explicit fields, so `capped` never reaches the provider.";

console.log("\n── Distribution (all runs) ──");
table(
  [
    ["per-turn aggregate chars", distribution.turns, fmt(distribution.perTurnAggChars.max), fmt(distribution.perTurnAggChars.mean), fmt(distribution.perTurnAggChars.p95)],
    ["individual result chars", distribution.individualResults, fmt(distribution.perResultChars.max), fmt(distribution.perResultChars.mean), "—"],
  ],
  ["series", "n", "max", "mean", "p95"],
);
console.log("\n── Hypothetical budget triggers ──");
table(
  BUDGETS.map((b) => [
    fmt(b), budgetTriggers[b].turnsExceeding, fmt(budgetTriggers[b].turnsExceedingPct, 1) + "%", budgetTriggers[b].individualResultsExceeding,
  ]),
  ["budget (chars)", "turns exceeding", "% of turns", "individual results exceeding"],
);
console.log("\n── Current caps ──");
console.log(JSON.stringify(currentCaps, null, 2));

writeResult("03-tool-result-bytes", {
  config: { dirs: DIRS, filesPerDir: FILES_PER_DIR, runs: RUNS, maxTurns: 10, thinking: "low", tools: TOOL_SET, budgets: BUDGETS },
  tasks: TASKS,
  runs,
  distribution,
  budgetTriggers,
  currentCaps,
  transcriptDivergence,
});
process.exit(0);
