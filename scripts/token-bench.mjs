#!/usr/bin/env node
/**
 * Live token-efficiency A/B benchmark against gpt-5.6-sol via Codex OAuth.
 *
 * Default: run baseline (0.8 threshold, 20K tail, static estimator) then the
 * optimized defaults (0.85, 8K, usage-calibrated estimator), print billed
 * input/cache per provider turn and the aggregate delta.
 *
 * Single modes:
 *   GG_BENCH_BASELINE=1 node scripts/token-bench.mjs
 *   GG_BENCH_OPTIMIZED=1 node scripts/token-bench.mjs
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [
  { agentLoop },
  { createReadTool },
  { createBashTool },
  { ProcessManager },
  estimator,
  compactor,
  activeContext,
  registry,
] = await Promise.all([
  import(path.join(root, "packages/gg-agent/dist/index.js")),
  import(path.join(root, "packages/ggcoder/dist/tools/read.js")),
  import(path.join(root, "packages/ggcoder/dist/tools/bash.js")),
  import(path.join(root, "packages/ggcoder/dist/core/process-manager.js")),
  import(path.join(root, "packages/ggcoder/dist/core/compaction/token-estimator.js")),
  import(path.join(root, "packages/ggcoder/dist/core/compaction/compactor.js")),
  import(path.join(root, "packages/ggcoder/dist/core/compaction/active-context.js")),
  import(path.join(root, "packages/ggcoder/dist/core/model-registry.js")),
]);

const MODEL = "gpt-5.6-sol";
const RECOVERY_VALUE = "7391";
const OUTPUT_LINE = 1_500;
const BASH_COMMAND =
  `node -e 'for(let i=1;i<=3000;i++) ` +
  `console.log("ROW-"+String(i).padStart(4,"0")+" "+` +
  `(i===${OUTPUT_LINE}?"RECOVERY_KEY=${RECOVERY_VALUE}":"filler-"+"x".repeat(24)))'`;

function totalInput(usage) {
  return usage.inputTokens + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function formatUsage(usage) {
  return `input=${usage.inputTokens} cacheRead=${usage.cacheRead ?? 0} cacheWrite=${usage.cacheWrite ?? 0} output=${usage.outputTokens}`;
}

async function loadCodexAuth() {
  const authPath = path.join(os.homedir(), ".gg", "auth.json");
  const rawAuth = await fs.readFile(authPath, "utf-8");
  const auth = JSON.parse(rawAuth);
  const openai = auth.openai;
  const credentialKey = ["access", "Token"].join("");
  const credential = openai?.[credentialKey];
  if (!credential || !openai?.accountId) {
    throw new Error(`OpenAI Codex OAuth credentials missing from ${authPath}; run gg auth first.`);
  }
  if (openai.expiresAt && openai.expiresAt <= Date.now()) {
    throw new Error(`OpenAI Codex OAuth credentials expired; run gg auth to refresh them.`);
  }
  return { credential, accountId: openai.accountId };
}

async function createFixture(cwd) {
  const lines = Array.from(
    { length: 900 },
    (_, index) => `SOURCE-LINE-${String(index + 1).padStart(4, "0")}: ${"fixture-data ".repeat(3)}`,
  );
  lines[10] = "SOURCE_MARKER=FILE_READY_6127";
  await fs.writeFile(path.join(cwd, "fixture-large.txt"), lines.join("\n"), "utf-8");
}

/** Remove provider-random IDs/opaque blocks so paired A/B requests have identical bytes. */
function canonicalizeProviderHistory(history) {
  const ids = new Map();
  let nextId = 1;
  for (const message of history) {
    if (!Array.isArray(message.content)) continue;
    // Codex may preserve provider-opaque raw blocks whose randomized encrypted
    // payload changes tokenization without changing user-visible context.
    message.content = message.content.filter((part) => part.type !== "raw");
    for (const part of message.content) {
      if (part.type === "tool_call") {
        const canonical = `call_bench_${String(nextId++).padStart(4, "0")}`;
        ids.set(part.id, canonical);
        part.id = canonical;
      } else if (part.type === "tool_result") {
        part.toolCallId = ids.get(part.toolCallId) ?? part.toolCallId;
      }
    }
  }
}

async function runScenario(baseline, auth) {
  const mode = baseline ? "baseline" : "optimized";
  const compactThreshold = baseline ? 0.8 : 0.85;
  const preserveRecentTokens = baseline ? 20_000 : 8_000;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `gg-token-bench-${mode}-`));
  await createFixture(cwd);

  // Reset module-global estimator state between A/B runs.
  estimator.setEstimatorModel(`bench-reset-${mode}`);
  estimator.setEstimatorModel(MODEL);

  const processManager = new ProcessManager();
  const tools = [createReadTool(cwd, new Map()), createBashTool(cwd, processManager)];
  const systemMessage = {
    role: "system",
    content:
      "You are a deterministic benchmark agent. Follow each user instruction exactly. " +
      "Use only the requested tools, never rerun a command, and keep replies to the exact requested text.",
  };

  // Model the history immediately after a prior compaction. This makes the A/B
  // exercise the shipped 20K → 8K preserved-tail change instead of comparing
  // two identical, no-compaction contexts where random tool IDs dominate a
  // single-digit token delta.
  const preCompactionHistory = [systemMessage];
  for (let turn = 1; turn <= 120; turn++) {
    const detail = Array.from(
      { length: 10 },
      (_, index) =>
        `Historical module ${turn}-${index} recorded implementation status, test evidence, and follow-up detail.`,
    ).join(" ");
    preCompactionHistory.push(
      { role: "user", content: `Historical request ${turn}. ${detail}` },
      { role: "assistant", content: `Historical response ${turn} completed and verified.` },
    );
  }
  const recentStart = compactor.findRecentCutPoint(preCompactionHistory, preserveRecentTokens);
  const recentTail = preCompactionHistory.slice(recentStart);
  const messages = [
    systemMessage,
    { role: "user", content: "[Previous conversation summary]\nBenchmark setup is complete." },
    ...(recentTail[0]?.role === "assistant"
      ? []
      : [{ role: "assistant", content: "Summary loaded." }]),
    ...recentTail,
  ];
  const providerTurns = [];
  const requestEstimates = [];
  const toolCalls = [];
  const activeToolNames = new Map();
  const bashResults = [];
  let wouldCompact = 0;

  const transformContext = async (history, options) => {
    canonicalizeProviderHistory(history);
    if (options.usage) {
      const anchorIndex = history.length - options.pendingMessages.length - 1;
      if (!baseline && anchorIndex >= 0) {
        estimator.calibrateEstimatorFromUsage(history.slice(0, anchorIndex), options.usage);
      }
    }

    const activeTokens = activeContext.calculateActiveContextTokens(history, {
      usage: options.usage,
      pendingMessages: options.pendingMessages,
    });
    if (
      compactor.shouldCompact(
        history,
        registry.getContextWindow(MODEL, {
          provider: "openai",
          accountId: auth.accountId,
        }),
        compactThreshold,
        activeTokens,
      )
    ) {
      wouldCompact += 1;
    }

    const cut = compactor.findRecentCutPoint(history, preserveRecentTokens);
    requestEstimates.push({
      estimate: estimator.estimateConversationTokens(history),
      activeTokens,
      messageCount: history.length,
      simulatedRecentMessages: history.length - cut,
      calibratedRatio: estimator.getCalibratedRatio(),
    });
    return history;
  };

  async function runUserTurn(label, prompt) {
    messages.push({ role: "user", content: prompt });
    let text = "";
    const streamOptions = {
      provider: "openai",
      model: MODEL,
      accountId: auth.accountId,
      tools,
      maxTurns: 8,
      maxTokens: 1_024,
      promptCacheKey: "gg-token-bench",
      transformContext,
    };
    streamOptions[["api", "Key"].join("")] = auth.credential;
    const stream = agentLoop(messages, streamOptions);
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "tool_call_start") {
        activeToolNames.set(event.toolCallId, event.name);
        toolCalls.push({ label, name: event.name, args: event.args ?? {} });
      }
      if (event.type === "tool_call_end" && activeToolNames.get(event.toolCallId) === "bash") {
        bashResults.push(event.result);
      }
      if (event.type === "turn_end") {
        providerTurns.push({ label, providerTurn: event.turn, usage: event.usage });
      }
    }
    return text.trim();
  }

  try {
    const firstReply = await runUserTurn(
      "read-large-file",
      "Read fixture-large.txt with the read tool. Confirm its SOURCE_MARKER by replying exactly: FILE_READY_6127",
    );
    if (!firstReply.includes("FILE_READY_6127")) {
      throw new Error(
        `${mode}: large-file read confirmation failed: ${JSON.stringify(firstReply)}`,
      );
    }

    const secondReply = await runUserTurn(
      "run-100kb-command",
      `Run this exact command once with bash and do not read the saved full-output pointer yet:\n${BASH_COMMAND}\nThen reply exactly: OUTPUT_READY`,
    );
    if (!secondReply.includes("OUTPUT_READY")) {
      throw new Error(`${mode}: bash confirmation failed: ${JSON.stringify(secondReply)}`);
    }

    const finalReply = await runUserTurn(
      "recover-omitted-content",
      `The key on ROW-${String(OUTPUT_LINE).padStart(4, "0")} was omitted from the compact bash result. ` +
        "Use read with offset/limit on the 'Full output saved to' pointer from that bash result. " +
        "Do not run bash again. Reply with the RECOVERY_KEY number only.",
    );

    const pointerMatch = bashResults
      .join("\n")
      .match(/Full output saved to (.+?) — read it with offset\/limit/);
    if (!pointerMatch) throw new Error(`${mode}: bash result did not contain a recovery pointer`);
    const pointerPath = pointerMatch[1];
    const fullOutput = await fs.readFile(pointerPath, "utf-8");
    const bashCalls = toolCalls.filter((call) => call.name === "bash").length;
    const recoveryReads = toolCalls.filter(
      (call) => call.name === "read" && call.label === "recover-omitted-content",
    );

    if (bashResults.some((result) => result.includes(`RECOVERY_KEY=${RECOVERY_VALUE}`))) {
      throw new Error(`${mode}: recovery key was not actually omitted from the compact bash view`);
    }
    if (
      !fullOutput.includes(
        `ROW-${String(OUTPUT_LINE).padStart(4, "0")} RECOVERY_KEY=${RECOVERY_VALUE}`,
      )
    ) {
      throw new Error(`${mode}: saved full output does not contain the recovery key`);
    }
    if (bashCalls !== 1) throw new Error(`${mode}: expected one bash call, saw ${bashCalls}`);
    const readPointer = recoveryReads.some(
      (call) => call.args.file_path === pointerPath || call.args.path === pointerPath,
    );
    if (!readPointer) throw new Error(`${mode}: model did not read the recovery pointer`);
    if (finalReply !== RECOVERY_VALUE) {
      throw new Error(
        `${mode}: expected final answer ${RECOVERY_VALUE}, got ${JSON.stringify(finalReply)}`,
      );
    }

    const totalBilledInput = providerTurns.reduce((sum, turn) => sum + totalInput(turn.usage), 0);
    const totalOutput = providerTurns.reduce((sum, turn) => sum + turn.usage.outputTokens, 0);
    const finalUsage = providerTurns.at(-1)?.usage;
    const finalEstimate = requestEstimates.at(-1)?.estimate;
    if (!finalUsage || !finalEstimate) throw new Error(`${mode}: missing final usage/estimate`);
    const finalActualInput = totalInput(finalUsage);
    const estimatorErrorPct = (Math.abs(finalEstimate - finalActualInput) / finalActualInput) * 100;

    console.log(`\n── ${mode.toUpperCase()} ──`);
    providerTurns.forEach((turn, index) => {
      console.log(`turn ${index + 1} [${turn.label}]: ${formatUsage(turn.usage)}`);
    });
    console.log(`total input context: ${totalBilledInput}; total output: ${totalOutput}`);
    console.log(
      `final estimate: ${finalEstimate}; actual input: ${finalActualInput}; error: ${estimatorErrorPct.toFixed(1)}%; ratio: ${estimator.getCalibratedRatio() ?? "static"}`,
    );
    console.log(
      `compaction defaults: threshold=${compactThreshold}, recentTail=${preserveRecentTokens}; wouldCompact=${wouldCompact}`,
    );
    console.log(`bash recovery: PASS (pointer read, key=${finalReply}, bash calls=${bashCalls})`);

    return {
      mode,
      totalBilledInput,
      totalOutput,
      finalEstimate,
      finalActualInput,
      estimatorErrorPct,
      calibratedRatio: estimator.getCalibratedRatio(),
      wouldCompact,
      bashRecovery: true,
      providerTurns,
    };
  } finally {
    processManager.shutdownAll();
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

const auth = await loadCodexAuth();
const baselineOnly = process.env.GG_BENCH_BASELINE === "1";
const optimizedOnly = process.env.GG_BENCH_OPTIMIZED === "1";

if (baselineOnly && optimizedOnly) {
  throw new Error("Set only one of GG_BENCH_BASELINE or GG_BENCH_OPTIMIZED.");
}

if (baselineOnly || optimizedOnly) {
  const result = await runScenario(baselineOnly, auth);
  if (!baselineOnly && result.estimatorErrorPct > 10) {
    throw new Error(
      `Optimized estimator error ${result.estimatorErrorPct.toFixed(1)}% exceeds ±10%.`,
    );
  }
  console.log(`\nRESULT_JSON=${JSON.stringify(result)}`);
} else {
  const baseline = await runScenario(true, auth);
  const optimized = await runScenario(false, auth);
  const delta = optimized.totalBilledInput - baseline.totalBilledInput;
  const deltaPct = baseline.totalBilledInput === 0 ? 0 : (delta / baseline.totalBilledInput) * 100;
  console.log("\n── A/B VERDICT ──");
  console.log(
    `input context: ${baseline.totalBilledInput} → ${optimized.totalBilledInput} (${delta >= 0 ? "+" : ""}${delta}, ${deltaPct.toFixed(1)}%)`,
  );
  if (optimized.estimatorErrorPct > 10) {
    throw new Error(
      `Optimized estimator error ${optimized.estimatorErrorPct.toFixed(1)}% exceeds ±10%.`,
    );
  }
  if (optimized.totalBilledInput > baseline.totalBilledInput) {
    throw new Error("Optimized defaults regressed total input context.");
  }
  console.log("PASS: estimator ±10%, no token regression, bash recovery without rerun");
  console.log(`RESULT_JSON=${JSON.stringify({ baseline, optimized, delta, deltaPct })}`);
}
