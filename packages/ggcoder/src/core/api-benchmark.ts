/**
 * Real-API speed benchmark — sends actual requests to a live provider and
 * measures TTFT, output throughput, cache behavior, and wall-clock latency.
 *
 * Unlike the mock benchmark, this hits real endpoints and produces
 * production-representative numbers. Uses gg's own AuthStorage to resolve
 * credentials (same path as a real session).
 *
 * Usage:
 *   npx tsx src/core/api-benchmark.ts
 *
 * Environment overrides:
 *   GG_BENCH_PROVIDER  — provider name (default: "glm")
 *   GG_BENCH_MODEL     — model id (default: "glm-5.2")
 *   GG_BENCH_TURNS     — number of turns (default: 5)
 */

import { stream, type Message, type StreamEvent, type Usage } from "@kenkaiiii/gg-ai";
import { AuthStorage } from "./auth-storage.js";

// ── Types ───────────────────────────────────────────────────

export interface ApiTurnMetrics {
  turn: number;
  prompt: string;
  ttftMs: number;
  outputTokens: number;
  outputDurationMs: number;
  tokensPerSecond: number;
  wallClockMs: number;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHit: boolean;
  stopReason: string;
}

export interface ApiBenchmarkResult {
  provider: string;
  model: string;
  turns: ApiTurnMetrics[];
  totalWallClockMs: number;
  totalTtftMs: number;
  totalOutputTokens: number;
  avgTokensPerSecond: number;
  avgTtftMs: number;
  cacheHits: number;
  cacheHitRate: number;
}

// ── System prompt (realistic coding-agent prefix) ──────────

function buildSystemPrompt(): string {
  return [
    "You are GG Coder — a coding agent that works directly in the user's codebase.",
    "You explore, understand, change, and verify code — completing tasks end-to-end",
    "rather than just suggesting edits.",
    "",
    "## How to Talk",
    "Don't narrate tool calls. Stay silent between tools unless you have a decision.",
    "Final replies: 1-3 sentences, hard cap 5.",
    "",
    "## How to Work",
    "- Read before edit/write; re-read after formatters or codegen.",
    "- Compute in bash; write with edit/write so read-tracking stays intact.",
    "- Keep edits small; plan multi-file work first.",
    "- Choose targeted verification appropriate to the change.",
    "",
    "## Tools",
    "- read: Read file contents",
    "- write: Write file contents",
    "- edit: Replace text in a file via search-replace blocks",
    "- bash: Execute shell commands",
    "- grep: Search file contents using regex",
    "- find: Find files matching a glob pattern",
    "",
    "## Code Quality",
    "Intent-revealing names; reuse existing deps. Types first; handle I/O and errors.",
    "No dead/commented code, placeholders, or unasked refactors.",
    "",
    "## Environment",
    "- Working directory: /home/user/my-project",
    "- Platform: linux",
    "",
    "<!-- uncached -->",
    "Today's date: 20 June 2026",
  ].join("\n");
}

// ── Conversation turns ──────────────────────────────────────

/** Prompts designed to produce 100-300 token responses so throughput
 *  measurement is meaningful (the simple one-liners gave 8-13 tokens
 *  which made tok/s unreliable). */
const CONVERSATION_TURNS = [
  "Write a TypeScript function `rateLimit(opts: { maxAttempts: number; windowMs: number })` that returns an Express middleware. Include the full implementation with comments, error handling, and an in-memory store. Make it production quality.",
  "Now write a test file for that rate limiter using vitest. Cover the happy path, rate limit exceeded, window reset, and multiple IPs. Include at least 4 test cases with full implementations.",
  "Refactor the rate limiter to support a Redis backend as an alternative to the in-memory store. Show the interface, both implementations, and a factory function. Keep it backward compatible.",
  "Write a README section documenting the rate limiter API: installation, usage examples for both backends, configuration options, and a comparison table of in-memory vs Redis.",
  "Review the entire rate limiter module for security issues, edge cases, and performance. Write a brief analysis with specific findings and recommended fixes for each issue.",
];

// ── Benchmark runner ────────────────────────────────────────

export async function runApiBenchmark(config: {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  accountId?: string;
  cacheRetention?: "short" | "long";
  promptCacheKey?: string;
  turns?: number;
}): Promise<ApiBenchmarkResult> {
  const {
    provider,
    model,
    apiKey,
    baseUrl,
    accountId,
    cacheRetention = "long",
    promptCacheKey = `bench-${Date.now()}`,
    turns = 5,
  } = config;

  const messages: Message[] = [{ role: "system", content: buildSystemPrompt() }];

  const turnMetrics: ApiTurnMetrics[] = [];

  for (let i = 0; i < turns; i++) {
    const userPrompt = CONVERSATION_TURNS[i % CONVERSATION_TURNS.length]!;
    messages.push({ role: "user", content: userPrompt });

    const turnStart = Date.now();
    let ttftMs = 0;
    let firstToken = true;

    const result = stream({
      provider: provider as never,
      model,
      messages: [...messages],
      maxTokens: 1024,
      apiKey,
      baseUrl,
      accountId,
      cacheRetention,
      promptCacheKey,
    });

    let response: { message: Message; usage: Usage; stopReason: string };

    try {
      // Consume the stream, measuring TTFT on first event.
      for await (const event of result as AsyncIterable<StreamEvent>) {
        if (firstToken && (event.type === "text_delta" || event.type === "thinking_delta")) {
          ttftMs = Date.now() - turnStart;
          firstToken = false;
        }
        if (event.type === "text_delta") {
          // Output counting happens via usage.outputTokens from the response.
        }
      }
      response = await result.response;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  Turn ${i + 1} FAILED: ${errMsg.slice(0, 200)}`);
      turnMetrics.push({
        turn: i + 1,
        prompt: userPrompt.slice(0, 50),
        ttftMs: 0,
        outputTokens: 0,
        outputDurationMs: 0,
        tokensPerSecond: 0,
        wallClockMs: Date.now() - turnStart,
        inputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheHit: false,
        stopReason: "error",
      });
      // Don't continue — conversation context is broken after an error
      break;
    }

    const wallClockMs = Date.now() - turnStart;
    const outputTokens = response.usage.outputTokens;
    const outputDurationMs = wallClockMs - ttftMs;
    const tokensPerSecond = outputDurationMs > 0 ? (outputTokens / outputDurationMs) * 1000 : 0;
    const cacheRead = response.usage.cacheRead ?? 0;

    turnMetrics.push({
      turn: i + 1,
      prompt: userPrompt.slice(0, 50),
      ttftMs,
      outputTokens,
      outputDurationMs,
      tokensPerSecond,
      wallClockMs,
      inputTokens: response.usage.inputTokens,
      cacheRead,
      cacheWrite: response.usage.cacheWrite ?? 0,
      cacheHit: cacheRead > 0,
      stopReason: response.stopReason,
    });

    // Append assistant reply for next turn.
    const assistantContent =
      typeof response.message.content === "string"
        ? response.message.content
        : (response.message.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
    messages.push({ role: "assistant", content: assistantContent });

    // Brief pause between turns (realistic user think time).
    if (i < turns - 1) {
      await sleep(2000);
    }

    // Progress output.
    process.stdout.write(
      `  Turn ${i + 1}/${turns}: TTFT ${ttftMs}ms | ${tokensPerSecond.toFixed(0)} tok/s | ` +
        `${outputTokens} out | cache ${cacheRead > 0 ? "HIT" : "miss"}` +
        `${cacheRead > 0 ? ` (${cacheRead} tok)` : ""}\n`,
    );
  }

  const totalWallClockMs = turnMetrics.reduce((s, t) => s + t.wallClockMs, 0);
  const totalTtftMs = turnMetrics.reduce((s, t) => s + t.ttftMs, 0);
  const totalOutputTokens = turnMetrics.reduce((s, t) => s + t.outputTokens, 0);
  const cacheHits = turnMetrics.filter((t) => t.cacheHit).length;
  const validTurns = turnMetrics.filter((t) => t.stopReason !== "error");
  const avgTokensPerSecond =
    validTurns.length > 0
      ? validTurns.reduce((s, t) => s + t.tokensPerSecond, 0) / validTurns.length
      : 0;
  const avgTtftMs = validTurns.length > 0 ? totalTtftMs / validTurns.length : 0;

  return {
    provider,
    model,
    turns: turnMetrics,
    totalWallClockMs,
    totalTtftMs,
    totalOutputTokens,
    avgTokensPerSecond,
    avgTtftMs,
    cacheHits,
    cacheHitRate: turnMetrics.length > 0 ? cacheHits / turnMetrics.length : 0,
  };
}

// ── Formatting ──────────────────────────────────────────────

export function formatApiResult(result: ApiBenchmarkResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push(`║  API BENCHMARK: ${result.provider} / ${result.model}`.padEnd(63) + "║");
  lines.push("╠══════════════════════════════════════════════════════════════╣");
  lines.push("");
  lines.push("┌──────┬────────────┬──────────┬───────────┬────────┬──────────┐");
  lines.push("│ Turn │ TTFT       │ Output   │ Tok/s     │ Cache  │ Wall     │");
  lines.push("├──────┼────────────┼──────────┼───────────┼────────┼──────────┤");

  for (const t of result.turns) {
    const cacheLabel = t.cacheHit ? " HIT " : "miss";
    lines.push(
      `│ ${String(t.turn).padStart(4)} │ ${fmt(t.ttftMs).padStart(10)} │ ` +
        `${String(t.outputTokens).padStart(8)} │ ${t.tokensPerSecond.toFixed(0).padStart(9)} │ ` +
        `${cacheLabel} │ ${fmt(t.wallClockMs).padStart(8)} │`,
    );
  }

  lines.push("└──────┴────────────┴──────────┴───────────┴────────┴──────────┘");
  lines.push("");
  lines.push("┌─────────────────────────────┬──────────────────────────────┐");
  lines.push("│ Metric                      │ Value                        │");
  lines.push("├─────────────────────────────┼──────────────────────────────┤");
  lines.push(`│ Avg TTFT                    │ ${fmt(result.avgTtftMs).padStart(28)} │`);
  lines.push(
    `│ Avg output throughput       │ ${result.avgTokensPerSecond.toFixed(0).padStart(22)} tok/s │`,
  );
  lines.push(`│ Total output tokens         │ ${String(result.totalOutputTokens).padStart(28)} │`);
  lines.push(`│ Total wall-clock            │ ${fmt(result.totalWallClockMs).padStart(28)} │`);
  lines.push(`│ Cache hits                  │ ${String(result.cacheHits).padStart(28)} │`);
  lines.push(
    `│ Cache hit rate              │ ${(result.cacheHitRate * 100).toFixed(0).padStart(27)}% │`,
  );
  lines.push("└─────────────────────────────┴──────────────────────────────┘");
  lines.push("");
  return lines.join("\n");
}

function fmt(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── CLI entry point ─────────────────────────────────────────

// ── A/B Comparison ─────────────────────────────────────────

export interface ApiComparisonResult {
  baseline: ApiBenchmarkResult;
  optimized: ApiBenchmarkResult;
  ttftImprovement: number;
  throughputImprovement: number;
  wallClockImprovement: number;
  cacheHitRateDelta: number;
}

/** Format an A/B comparison between two API benchmark runs. */
export function formatApiComparison(c: ApiComparisonResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║      REAL API A/B: BASELINE vs OPTIMIZED                   ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(formatApiResult(c.baseline));
  lines.push(formatApiResult(c.optimized));
  lines.push("┌─────────────────────────────┬──────────────┬──────────────┬───────────┐");
  lines.push("│ Metric                      │    Baseline  │   Optimized  │    Delta  │");
  lines.push("├─────────────────────────────┼──────────────┼──────────────┼───────────┤");
  // TTFT/wall-clock: delta = (baseline - optimized), positive = faster = show -X%.
  const pctDown = (delta: number) =>
    `${delta >= 0 ? "-" : "+"}${Math.abs(delta).toFixed(1).padStart(5)}%`;
  // Throughput: delta = (optimized - baseline), positive = faster = show +X%.
  const pctUp = (delta: number) =>
    `${delta >= 0 ? "+" : "-"}${Math.abs(delta).toFixed(1).padStart(5)}%`;
  lines.push(
    `│ Avg TTFT                    │ ${fmt(c.baseline.avgTtftMs).padStart(11)} │ ${fmt(c.optimized.avgTtftMs).padStart(11)} │ ${pctDown(c.ttftImprovement).padStart(8)} │`,
  );
  lines.push(
    `│ Avg throughput (tok/s)      │ ${String(c.baseline.avgTokensPerSecond.toFixed(0)).padStart(11)} │ ${String(c.optimized.avgTokensPerSecond.toFixed(0)).padStart(11)} │ ${pctUp(c.throughputImprovement).padStart(8)} │`,
  );
  lines.push(
    `│ Total wall-clock            │ ${fmt(c.baseline.totalWallClockMs).padStart(11)} │ ${fmt(c.optimized.totalWallClockMs).padStart(11)} │ ${pctDown(c.wallClockImprovement).padStart(8)} │`,
  );
  lines.push(
    `│ Cache hit rate              │ ${(c.baseline.cacheHitRate * 100).toFixed(0).padStart(10)}% │ ${(c.optimized.cacheHitRate * 100).toFixed(0).padStart(10)}% │ ${c.cacheHitRateDelta >= 0 ? "+" : ""}${c.cacheHitRateDelta.toFixed(0).padStart(5)}pp │`,
  );
  lines.push("└─────────────────────────────┴──────────────┴──────────────┴───────────┘");
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const provider = process.env.GG_BENCH_PROVIDER ?? "glm";
  const model = process.env.GG_BENCH_MODEL ?? "glm-5.2";
  const turns = parseInt(process.env.GG_BENCH_TURNS ?? "5", 10);
  const mode = process.env.GG_BENCH_MODE ?? "compare"; // "single" or "compare"

  // Resolve credentials using gg's AuthStorage (same path as a real session).
  const authStorage = new AuthStorage();
  await authStorage.load();

  let apiKey: string;
  let baseUrl: string | undefined;
  let accountId: string | undefined;

  try {
    const creds = await authStorage.resolveCredentials(provider);
    apiKey = creds.accessToken;
    baseUrl = creds.baseUrl;
    accountId = creds.accountId;
  } catch (err) {
    console.error(
      `❌ Could not resolve credentials for "${provider}". ` +
        `Make sure you're logged in: run \`ggcoder login\` and choose ${provider}.\n` +
        `   Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  if (!apiKey) {
    console.error(`❌ Resolved credentials for "${provider}" but accessToken is empty.`);
    process.exit(1);
  }

  console.log(`\n🔍 API Benchmark: ${provider}/${model} — mode: ${mode} (${turns} turns)`);
  console.log(`   API key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  console.log(`   Base URL: ${baseUrl ?? "(provider default)"}`);
  if (accountId) console.log(`   Account ID: ${accountId}`);
  console.log("");

  if (mode === "single") {
    const result = await runApiBenchmark({
      provider,
      model,
      apiKey,
      baseUrl,
      accountId,
      cacheRetention: "long",
      promptCacheKey: `bench-${provider}-${Date.now()}`,
      turns,
    });
    console.log(formatApiResult(result));
    return;
  }

  // A/B comparison mode.
  console.log("━".repeat(50));
  console.log("▶ BASELINE: cacheRetention=short, no prewarm");
  console.log("━".repeat(50));
  const baseline = await runApiBenchmark({
    provider,
    model,
    apiKey,
    baseUrl,
    accountId,
    cacheRetention: "short",
    promptCacheKey: `bench-base-${provider}-${Date.now()}`,
    turns,
  });

  // Cool-down between runs so the second run isn't affected by connection warming.
  console.log("\n⏳ Cooling down 5s between runs...\n");
  await sleep(5000);

  console.log("━".repeat(50));
  console.log("▶ OPTIMIZED: cacheRetention=long + prewarm");
  console.log("━".repeat(50));

  // Fire a prewarm request before the optimized run (same as AgentSession does).
  if (provider === "anthropic") {
    const { prewarmAnthropicCache } = await import("@kenkaiiii/gg-ai");
    await prewarmAnthropicCache({
      apiKey,
      model,
      system: buildSystemPrompt(),
      cacheRetention: "long",
      baseUrl,
    }).catch(() => {});
    console.log("   (prewarm sent)");
  } else {
    // For non-Anthropic providers, fire a minimal warm-up request to prime
    // the provider's prefix cache (GLM, OpenAI, etc. auto-cache on first hit).
    console.log("   (warm-up request for prefix cache)");
    await runApiBenchmark({
      provider,
      model,
      apiKey,
      baseUrl,
      accountId,
      cacheRetention: "long",
      promptCacheKey: `bench-warm-${provider}-${Date.now()}`,
      turns: 1,
    }).catch(() => {});
  }

  const optimized = await runApiBenchmark({
    provider,
    model,
    apiKey,
    baseUrl,
    accountId,
    cacheRetention: "long",
    promptCacheKey: `bench-opt-${provider}-${Date.now()}`,
    turns,
  });

  const ttftImprovement =
    baseline.avgTtftMs > 0
      ? ((baseline.avgTtftMs - optimized.avgTtftMs) / baseline.avgTtftMs) * 100
      : 0;
  const throughputImprovement =
    baseline.avgTokensPerSecond > 0
      ? ((optimized.avgTokensPerSecond - baseline.avgTokensPerSecond) /
          baseline.avgTokensPerSecond) *
        100
      : 0;
  const wallClockImprovement =
    baseline.totalWallClockMs > 0
      ? ((baseline.totalWallClockMs - optimized.totalWallClockMs) / baseline.totalWallClockMs) * 100
      : 0;

  const comparison: ApiComparisonResult = {
    baseline,
    optimized,
    ttftImprovement,
    throughputImprovement,
    wallClockImprovement,
    cacheHitRateDelta: (optimized.cacheHitRate - baseline.cacheHitRate) * 100,
  };

  console.log(formatApiComparison(comparison));
}

// Run when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1]?.endsWith("api-benchmark.ts") ||
  process.argv[1]?.endsWith("api-benchmark.js") ||
  process.argv[1]?.endsWith("api-benchmark");

if (isDirectRun) {
  main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
