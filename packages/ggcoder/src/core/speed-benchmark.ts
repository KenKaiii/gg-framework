/**
 * Speed benchmark harness — measures the latency impact of speedProfile
 * optimizations (1-h cache TTL + pre-warming) against the current baseline
 * (5-min cache TTL, no pre-warm).
 *
 * Uses a mock streaming provider that simulates realistic provider timing:
 *   - Cold prefill (cache miss): proportional to uncached input tokens
 *   - Warm prefill (cache hit): 10× faster (cache reads cost 0.1×)
 *   - Output streaming: at a configurable token rate
 *   - Cache TTL: configurable (5 min baseline vs 1 h optimized)
 *
 * No real API calls are made — the mock uses real `setTimeout` for prefill and
 * output-token latency (so wall-clock measurements are meaningful) but a
 * virtual clock for inter-turn delays (so multi-minute gaps are instant).
 *
 * Run via vitest:  npx vitest run src/core/speed-benchmark.test.ts
 * Or as a script:  npx tsx src/core/speed-benchmark.ts
 */

import {
  StreamResult,
  type StreamOptions,
  type StreamEvent,
  type StreamResponse,
} from "@kenkaiiii/gg-ai";
import { z } from "zod";

// ── Mock Provider Config ────────────────────────────────────

export interface MockTimingConfig {
  /** ms per uncached input token during prefill (cold start). */
  coldPrefillMsPerToken: number;
  /** ms per cached input token during prefill (cache hit). 10× faster. */
  warmPrefillMsPerToken: number;
  /** ms per output token (determines streaming rate). ~15ms = 66 tok/s. */
  outputMsPerToken: number;
  /** Cache TTL in ms. 5_000 = baseline (5 min), 3_600_000 = optimized (1 h). */
  cacheTtlMs: number;
  /** Fixed network overhead per request (TCP + TLS + auth). */
  networkOverheadMs: number;
  /** Default output tokens per turn if not specified by the workload. */
  defaultOutputTokens: number;
}

export const REALISTIC_TIMING: MockTimingConfig = {
  coldPrefillMsPerToken: 0.15, // 10k tokens = 1.5s prefill
  warmPrefillMsPerToken: 0.015, // 10k tokens cached = 0.15s prefill (10× faster)
  outputMsPerToken: 12, // ~83 tok/s output
  cacheTtlMs: 5 * 60 * 1000, // 5 min (baseline)
  networkOverheadMs: 200, // 200ms fixed network overhead
  defaultOutputTokens: 150,
};

// ── Mock Cache State ────────────────────────────────────────

interface CacheEntry {
  createdAt: number;
  tokenCount: number;
}

// ── Mock Provider Implementation ────────────────────────────

/**
 * A mock streaming provider that simulates LLM timing with cache semantics.
 * Registered as provider "benchmark-mock" so the real agent loop code path
 * is exercised end-to-end.
 */
export class MockBenchmarkProvider {
  private cache = new Map<string, CacheEntry>();
  private config: MockTimingConfig;
  /** Virtual clock — lets the benchmark simulate multi-minute gaps between
   *  turns without actually sleeping. The cache TTL check uses this, not
   *  Date.now(). Only prefill/output latency uses real setTimeout. */
  private virtualNow = 0;
  readonly stats = {
    cacheHits: 0,
    cacheMisses: 0,
    cacheWrites: 0,
    cacheEvictions: 0,
    totalPrefillMs: 0,
    totalOutputMs: 0,
    totalNetworkMs: 0,
    turns: 0,
  };

  constructor(config: Partial<MockTimingConfig> = {}) {
    this.config = { ...REALISTIC_TIMING, ...config };
  }

  /** Update config (e.g., switch TTL for baseline vs optimized run). */
  setConfig(config: Partial<MockTimingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Advance the virtual clock (for cache TTL simulation without real sleeping). */
  advanceClock(ms: number): void {
    this.virtualNow += ms;
  }

  /** Clear all cache state and stats (between benchmark runs). */
  reset(): void {
    this.cache.clear();
    this.virtualNow = 0;
    this.stats.cacheHits = 0;
    this.stats.cacheMisses = 0;
    this.stats.cacheWrites = 0;
    this.stats.cacheEvictions = 0;
    this.stats.totalPrefillMs = 0;
    this.stats.totalOutputMs = 0;
    this.stats.totalNetworkMs = 0;
    this.stats.turns = 0;
  }

  /** Number of entries currently in the mock cache. */
  getCacheSize(): number {
    return this.cache.size;
  }

  /** Force a cache write (simulates pre-warming). */
  prewarm(cacheKey: string, tokenCount: number): void {
    this.cache.set(cacheKey, { createdAt: this.virtualNow, tokenCount });
    this.stats.cacheWrites++;
  }

  stream(options: StreamOptions): StreamResult {
    const generator = this.runStream(options);
    return new StreamResult(generator, options.signal);
  }

  private async *runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
    const cfg = this.config;
    this.stats.turns++;

    // Estimate input tokens from message content (rough: 4 chars per token).
    let inputChars = 0;
    for (const msg of options.messages) {
      if (typeof msg.content === "string") {
        inputChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ("text" in part && typeof part.text === "string") inputChars += part.text.length;
          if ("content" in part && typeof part.content === "string")
            inputChars += part.content.length;
        }
      }
    }
    // Add tool schema overhead (~500 tokens for a typical tool set).
    if (options.tools?.length) {
      inputChars += options.tools.length * 2000;
    }
    const inputTokens = Math.ceil(inputChars / 4);

    // Compute cache key — hash the system prompt + tools (the stable prefix).
    const cacheKey = this.computeCacheKey(options);

    // Check cache state (using virtual clock, not real time).
    const now = this.virtualNow;
    const cached = this.cache.get(cacheKey);
    let isCacheHit = false;
    let prefillTokens = inputTokens;

    if (cached && now - cached.createdAt < cfg.cacheTtlMs) {
      // Cache hit — only the diff needs prefill.
      isCacheHit = true;
      prefillTokens = Math.max(0, inputTokens - cached.tokenCount);
      this.stats.cacheHits++;
    } else {
      // Cache miss or expired.
      if (cached && now - cached.createdAt >= cfg.cacheTtlMs) {
        this.stats.cacheEvictions++;
      }
      this.stats.cacheMisses++;
    }

    // Simulate prefill latency.
    const prefillRate = isCacheHit ? cfg.warmPrefillMsPerToken : cfg.coldPrefillMsPerToken;
    const prefillMs = prefillTokens * prefillRate;
    this.stats.totalPrefillMs += prefillMs;

    // Simulate network overhead.
    this.stats.totalNetworkMs += cfg.networkOverheadMs;

    // Wait for TTFT (network + prefill).
    const ttft = cfg.networkOverheadMs + prefillMs;
    await sleep(ttft);

    // Update cache after the request is processed.
    // On a miss: write a fresh entry. On a hit: refresh the TTL and update
    // the token count (mirrors Anthropic — reading from cache extends its TTL
    // and the prefix grows as new messages accumulate).
    this.cache.set(cacheKey, { createdAt: this.virtualNow, tokenCount: inputTokens });
    if (!isCacheHit) {
      this.stats.cacheWrites++;
    }

    // Determine output tokens.
    const outputTokens = cfg.defaultOutputTokens;

    // Stream output tokens.
    const outputMs = outputTokens * cfg.outputMsPerToken;
    this.stats.totalOutputMs += outputMs;

    let textAccum = "";
    for (let i = 0; i < outputTokens; i++) {
      await sleep(cfg.outputMsPerToken);
      const chunk = "x";
      textAccum += chunk;
      yield { type: "text_delta" as const, text: chunk };
    }

    yield { type: "done" as const, stopReason: "end_turn" as const };

    const response: StreamResponse = {
      message: { role: "assistant" as const, content: textAccum },
      stopReason: "end_turn" as const,
      usage: {
        inputTokens: isCacheHit ? prefillTokens : inputTokens,
        outputTokens,
        ...(isCacheHit ? { cacheRead: inputTokens - prefillTokens } : {}),
        ...(!isCacheHit ? { cacheWrite: inputTokens } : {}),
      },
    };
    return response;
  }

  /** Compute a stable cache key from the system prompt + tool names. */
  private computeCacheKey(options: StreamOptions): string {
    const systemMsg = options.messages.find((m) => m.role === "system");
    const systemText = typeof systemMsg?.content === "string" ? systemMsg.content : "";
    const toolNames = (options.tools ?? []).map((t) => t.name).join(",");
    return `${systemText.length}:${toolNames}`;
  }
}

// ── Benchmark Workload ──────────────────────────────────────

export interface WorkloadTurn {
  /** User message content. */
  prompt: string;
  /** Delay before this turn (simulates user think time). Default: 0. */
  delayMs?: number;
  /** Override output tokens for this turn. */
  outputTokens?: number;
}

export interface Workload {
  name: string;
  /** System prompt (simulates a realistic coding-agent system prompt). */
  systemPrompt: string;
  /** Tool definitions (names only for the mock). */
  toolNames: string[];
  turns: WorkloadTurn[];
}

export interface TurnMetrics {
  turnNumber: number;
  promptPreview: string;
  delayBeforeTurnMs: number;
  ttftMs: number;
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
  wallClockMs: number;
}

export interface BenchmarkResult {
  name: string;
  config: MockTimingConfig;
  prewarmed: boolean;
  turns: TurnMetrics[];
  totalWallClockMs: number;
  totalTtftMs: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
}

// ── Benchmark Runner ────────────────────────────────────────

/** Run a workload against the mock provider and collect per-turn metrics. */
export async function runBenchmark(
  workload: Workload,
  config: MockTimingConfig,
  options: { prewarm?: boolean; name?: string } = {},
): Promise<BenchmarkResult> {
  const provider = new MockBenchmarkProvider(config);

  // Build mock tools.
  const tools = workload.toolNames.map((name) => ({
    name,
    description: `Mock tool: ${name}`,
    parameters: z.object({}),
  }));

  // Build messages.
  const messages: StreamOptions["messages"] = [{ role: "system", content: workload.systemPrompt }];

  // Pre-warm if requested.
  if (options.prewarm) {
    const cacheKey = `${workload.systemPrompt.length}:${workload.toolNames.join(",")}`;
    const inputChars = workload.systemPrompt.length + workload.toolNames.length * 2000;
    provider.prewarm(cacheKey, Math.ceil(inputChars / 4));
  }

  const turnMetrics: TurnMetrics[] = [];

  for (let i = 0; i < workload.turns.length; i++) {
    const turn = workload.turns[i];

    // Simulate user delay before this turn — advance the virtual clock
    // (not real sleep) so multi-minute gaps are instant.
    if (turn.delayMs && turn.delayMs > 0) {
      provider.advanceClock(turn.delayMs);
    }

    if (turn.outputTokens) {
      provider.setConfig({ defaultOutputTokens: turn.outputTokens });
    }

    // Add user message.
    messages.push({ role: "user", content: turn.prompt });

    const turnStart = Date.now();

    // Measure TTFT.
    let ttftMs = 0;
    let firstEvent = true;

    const streamOptions: StreamOptions = {
      provider: "benchmark-mock" as never,
      model: "mock-model",
      messages: [...messages],
      tools,
      maxTokens: 4096,
    };

    const result = provider.stream(streamOptions);

    for await (const _event of result) {
      if (firstEvent) {
        ttftMs = Date.now() - turnStart;
        firstEvent = false;
      }
    }

    const response = await result.response;
    const cacheHit = (response.usage.cacheRead ?? 0) > 0;
    const inputTokens = response.usage.inputTokens + (response.usage.cacheRead ?? 0);
    const outputTokens = response.usage.outputTokens;

    const wallClockMs = Date.now() - turnStart;

    turnMetrics.push({
      turnNumber: i + 1,
      promptPreview: turn.prompt.slice(0, 50),
      delayBeforeTurnMs: turn.delayMs ?? 0,
      ttftMs,
      cacheHit,
      inputTokens,
      outputTokens,
      wallClockMs,
    });

    // Add assistant message for next turn.
    messages.push({
      role: "assistant",
      content: typeof response.message.content === "string" ? response.message.content : "",
    });
  }

  const cacheHits = turnMetrics.filter((t) => t.cacheHit).length;
  const cacheMisses = turnMetrics.length - cacheHits;

  return {
    name: options.name ?? workload.name,
    config,
    prewarmed: !!options.prewarm,
    turns: turnMetrics,
    totalWallClockMs: turnMetrics.reduce((sum, t) => sum + t.wallClockMs, 0),
    totalTtftMs: turnMetrics.reduce((sum, t) => sum + t.ttftMs, 0),
    cacheHits,
    cacheMisses,
    cacheHitRate: turnMetrics.length > 0 ? cacheHits / turnMetrics.length : 0,
  };
}

// ── Comparison & Reporting ──────────────────────────────────

export interface ComparisonResult {
  baseline: BenchmarkResult;
  optimized: BenchmarkResult;
  wallClockImprovement: number; // percentage
  ttftImprovement: number; // percentage
  cacheHitRateImprovement: number; // percentage points
}

export function compareResults(
  baseline: BenchmarkResult,
  optimized: BenchmarkResult,
): ComparisonResult {
  const wallClockImprovement =
    baseline.totalWallClockMs > 0
      ? ((baseline.totalWallClockMs - optimized.totalWallClockMs) / baseline.totalWallClockMs) * 100
      : 0;

  const ttftImprovement =
    baseline.totalTtftMs > 0
      ? ((baseline.totalTtftMs - optimized.totalTtftMs) / baseline.totalTtftMs) * 100
      : 0;

  const cacheHitRateImprovement = (optimized.cacheHitRate - baseline.cacheHitRate) * 100;

  return {
    baseline,
    optimized,
    wallClockImprovement,
    ttftImprovement,
    cacheHitRateImprovement,
  };
}

/** Format a benchmark result as a readable table. */
export function formatResultTable(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push(`┌─ ${result.name} ${"─".repeat(Math.max(0, 52 - result.name.length))}┐`);
  lines.push(
    `│ Cache TTL: ${formatDuration(result.config.cacheTtlMs)}  |  Prewarmed: ${result.prewarmed ? "YES" : "no"}${" ".repeat(18)}│`,
  );
  lines.push("│ Turn │ Delay    │ TTFT     │ Cache │ Wall     │ Input tok │");
  lines.push("│──────┼──────────┼──────────┼───────┼──────────┼───────────│");

  for (const turn of result.turns) {
    lines.push(
      `│ ${String(turn.turnNumber).padStart(4)} │ ${formatDuration(turn.delayBeforeTurnMs).padStart(8)} │ ${formatDuration(turn.ttftMs).padStart(8)} │ ${turn.cacheHit ? " HIT " : "MISS "} │ ${formatDuration(turn.wallClockMs).padStart(8)} │ ${String(turn.inputTokens).padStart(9)} │`,
    );
  }

  lines.push("└──────┴──────────┴──────────┴───────┴──────────┴───────────┘");
  lines.push(
    `│ Total: ${formatDuration(result.totalWallClockMs).padStart(8)}  |  TTFT: ${formatDuration(result.totalTtftMs).padStart(8)}  |  Hit rate: ${(result.cacheHitRate * 100).toFixed(0)}%${" ".repeat(6)}│`,
  );
  return lines.join("\n");
}

/** Format a side-by-side comparison. */
export function formatComparison(comparison: ComparisonResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║           SPEED BENCHMARK: BASELINE vs OPTIMIZED           ║");
  lines.push("╠══════════════════════════════════════════════════════════════╣");
  lines.push("");
  lines.push(formatResultTable(comparison.baseline));
  lines.push("");
  lines.push(formatResultTable(comparison.optimized));
  lines.push("");
  lines.push("┌─────────────────────────┬──────────────┬──────────────┬───────────┐");
  lines.push("│ Metric                  │    Baseline  │   Optimized  │    Delta  │");
  lines.push("├─────────────────────────┼──────────────┼──────────────┼───────────┤");
  lines.push(
    `│ Total wall-clock        │ ${formatDuration(comparison.baseline.totalWallClockMs).padStart(11)} │ ${formatDuration(comparison.optimized.totalWallClockMs).padStart(11)} │ ${comparison.wallClockImprovement >= 0 ? "-" : "+"}${Math.abs(comparison.wallClockImprovement).toFixed(1).padStart(5)}%  │`,
  );
  lines.push(
    `│ Total TTFT              │ ${formatDuration(comparison.baseline.totalTtftMs).padStart(11)} │ ${formatDuration(comparison.optimized.totalTtftMs).padStart(11)} │ ${comparison.ttftImprovement >= 0 ? "-" : "+"}${Math.abs(comparison.ttftImprovement).toFixed(1).padStart(5)}%  │`,
  );
  lines.push(
    `│ Cache hit rate          │ ${(comparison.baseline.cacheHitRate * 100).toFixed(0).padStart(10)}% │ ${(comparison.optimized.cacheHitRate * 100).toFixed(0).padStart(11)}% │ +${comparison.cacheHitRateImprovement.toFixed(0).padStart(4)}pp │`,
  );
  lines.push(
    `│ Cache hits / misses     │ ${String(comparison.baseline.cacheHits).padStart(5)} / ${String(comparison.baseline.cacheMisses).padStart(3)} │ ${String(comparison.optimized.cacheHits).padStart(11)} / ${String(comparison.optimized.cacheMisses).padStart(3)} │           │`,
  );
  lines.push("└─────────────────────────┴──────────────┴──────────────┴───────────┘");
  lines.push("");
  return lines.join("\n");
}

// ── Default Workload ────────────────────────────────────────

/** A realistic multi-turn coding workload with time gaps that expose the
 *  5-min vs 1-h TTL difference. */
export function createDefaultWorkload(): Workload {
  const systemPrompt = [
    "You are GG Coder — a coding agent that works directly in the user's codebase.",
    "You explore, understand, change, and verify code.",
    "",
    "## Tools",
    "- read: Read file contents",
    "- write: Write file contents",
    "- edit: Replace text in a file",
    "- bash: Execute shell commands",
    "- grep: Search file contents",
    "- find: Find files matching a pattern",
    "",
    "## Environment",
    `- Working directory: /home/user/project`,
    `- Platform: linux`,
  ].join("\n");

  return {
    name: "Multi-turn coding session",
    systemPrompt,
    toolNames: ["read", "write", "edit", "bash", "grep", "find", "ls", "web_fetch", "subagent"],
    turns: [
      {
        prompt: "Can you look at the auth module and tell me how it works?",
        delayMs: 0, // First turn — cold cache
        outputTokens: 200,
      },
      {
        prompt: "Great, now add a rate limiter to the login endpoint.",
        delayMs: 3 * 60 * 1000, // 3 min — within both TTLs
        outputTokens: 150,
      },
      {
        prompt: "Also add logging for failed login attempts.",
        delayMs: 4 * 60 * 1000, // 4 min — within both TTLs
        outputTokens: 120,
      },
      {
        prompt: "Now update the tests to cover the new rate limiter.",
        delayMs: 7 * 60 * 1000, // 7 min — BEYOND 5min TTL, within 1h
        outputTokens: 180,
      },
      {
        prompt: "Run the test suite to make sure everything passes.",
        delayMs: 2 * 60 * 1000, // 2 min — within both TTLs
        outputTokens: 100,
      },
    ],
  };
}

// ── Helpers ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

// ── Full Benchmark Runner ───────────────────────────────────

/** Run baseline vs optimized and return the comparison. Uses scaled-down
 *  timing (10× faster than real) so the benchmark completes in seconds. */
export async function runFullBenchmark(): Promise<ComparisonResult> {
  const workload = createDefaultWorkload();

  // Scale timing down 10× for fast test runs — ratios are preserved.
  const scale = 0.1;
  const baseConfig: MockTimingConfig = {
    coldPrefillMsPerToken: 0.15 * scale,
    warmPrefillMsPerToken: 0.015 * scale,
    outputMsPerToken: 12 * scale,
    networkOverheadMs: 200 * scale,
    defaultOutputTokens: 150,
    cacheTtlMs: 0, // set per-run below
  };

  // Baseline: 5-min TTL, no pre-warm.
  const baseline = await runBenchmark(
    workload,
    { ...baseConfig, cacheTtlMs: 5 * 60 * 1000 },
    {
      name: "BASELINE (5min TTL, no prewarm)",
    },
  );

  // Optimized: 1-h TTL, with pre-warm.
  const optimized = await runBenchmark(
    workload,
    { ...baseConfig, cacheTtlMs: 60 * 60 * 1000 },
    { name: "OPTIMIZED (1h TTL + prewarm)", prewarm: true },
  );

  return compareResults(baseline, optimized);
}
