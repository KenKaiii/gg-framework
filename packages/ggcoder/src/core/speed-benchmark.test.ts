import { describe, it, expect, onTestFinished, vi } from "vitest";
import {
  runFullBenchmark,
  runBenchmark,
  createDefaultWorkload,
  formatComparison,
  MockBenchmarkProvider,
  REALISTIC_TIMING,
  type MockTimingConfig,
} from "./speed-benchmark.js";

describe("Speed Benchmark", () => {
  it("optimized should be faster than baseline on multi-turn workload", async () => {
    const comparison = await runFullBenchmark();

    // Print the full comparison table for visibility.
    const report = formatComparison(comparison);
    console.log(report);

    // The optimized run should have a higher cache hit rate — the 7-min gap
    // turn (turn 4) misses the 5-min cache but hits the 1-h cache.
    expect(comparison.optimized.cacheHitRate).toBeGreaterThan(comparison.baseline.cacheHitRate);

    // The optimization target is lower TTFT. Total wall-clock includes fixed
    // output streaming sleeps and can jitter by a few milliseconds in CI.
    expect(comparison.optimized.totalTtftMs).toBeLessThan(comparison.baseline.totalTtftMs);

    // TTFT improvement should be meaningful (> 5%).
    expect(comparison.ttftImprovement).toBeGreaterThan(5);
  }, 30_000);

  it("baseline misses cache on turn after 5-min gap", async () => {
    const workload = createDefaultWorkload();
    const baselineConfig: MockTimingConfig = {
      ...REALISTIC_TIMING,
      coldPrefillMsPerToken: 0.015, // scaled for speed
      warmPrefillMsPerToken: 0.0015,
      outputMsPerToken: 1.2,
      networkOverheadMs: 20,
      cacheTtlMs: 5 * 60 * 1000, // 5 min
    };

    const result = await runBenchmark(workload, baselineConfig, {
      name: "5min TTL",
    });

    // Turn 4 has a 7-min delay — should be a cache miss with 5-min TTL.
    const turn4 = result.turns[3];
    expect(turn4).toBeDefined();
    expect(turn4.cacheHit).toBe(false);

    // Turns 2 and 3 (3-min and 4-min delays) should be cache hits.
    expect(result.turns[1].cacheHit).toBe(true);
    expect(result.turns[2].cacheHit).toBe(true);
    // These simulate a full multi-turn workload; the 5s default is not enough
    // headroom on a loaded CI runner (all three timed out on windows-latest).
  }, 30_000);

  it("optimized hits cache on turn after 5-min gap (1-h TTL)", async () => {
    const workload = createDefaultWorkload();
    const optimizedConfig: MockTimingConfig = {
      ...REALISTIC_TIMING,
      coldPrefillMsPerToken: 0.015,
      warmPrefillMsPerToken: 0.0015,
      outputMsPerToken: 1.2,
      networkOverheadMs: 20,
      cacheTtlMs: 60 * 60 * 1000, // 1 hour
    };

    const result = await runBenchmark(workload, optimizedConfig, {
      name: "1h TTL",
      prewarm: true,
    });

    // Turn 4 has a 7-min delay — should be a cache HIT with 1-h TTL.
    const turn4 = result.turns[3];
    expect(turn4).toBeDefined();
    expect(turn4.cacheHit).toBe(true);

    // Turn 1 should be a cache hit too (pre-warmed).
    expect(result.turns[0].cacheHit).toBe(true);
    // These simulate a full multi-turn workload; the 5s default is not enough
    // headroom on a loaded CI runner (all three timed out on windows-latest).
  }, 30_000);

  it("pre-warming makes first turn a cache hit", async () => {
    const workload = createDefaultWorkload();
    const config: MockTimingConfig = {
      ...REALISTIC_TIMING,
      coldPrefillMsPerToken: 0.015,
      warmPrefillMsPerToken: 0.0015,
      outputMsPerToken: 1.2,
      networkOverheadMs: 20,
      cacheTtlMs: 60 * 60 * 1000,
    };

    // Without pre-warm.
    const cold = await runBenchmark(workload, config, { name: "No prewarm" });
    expect(cold.turns[0].cacheHit).toBe(false);

    // With pre-warm.
    const warm = await runBenchmark(workload, config, {
      name: "With prewarm",
      prewarm: true,
    });
    expect(warm.turns[0].cacheHit).toBe(true);

    // First-turn TTFT should be lower with pre-warm.
    expect(warm.turns[0].ttftMs).toBeLessThan(cold.turns[0].ttftMs);
    // These simulate a full multi-turn workload; the 5s default is not enough
    // headroom on a loaded CI runner (all three timed out on windows-latest).
  }, 30_000);

  it("mock provider tracks stats correctly", () => {
    const provider = new MockBenchmarkProvider({
      ...REALISTIC_TIMING,
      cacheTtlMs: 60 * 60 * 1000,
    });

    // Pre-warm.
    provider.prewarm("test-key", 1000);
    expect(provider.stats.cacheWrites).toBe(1);

    // Reset.
    provider.reset();
    expect(provider.stats.cacheWrites).toBe(0);
    expect(provider.getCacheSize()).toBe(0);
  });

  it("paces output to its schedule without dropping tokens or changing stats", async () => {
    const config: MockTimingConfig = {
      ...REALISTIC_TIMING,
      coldPrefillMsPerToken: 0,
      networkOverheadMs: 0,
      outputMsPerToken: 1.2,
    };
    const provider = new MockBenchmarkProvider(config);
    const timers = vi.spyOn(globalThis, "setTimeout");
    onTestFinished(() => timers.mockRestore());

    const started = performance.now();
    const result = provider.stream({
      provider: "benchmark-mock" as never,
      model: "mock-model",
      messages: [{ role: "user", content: "Stream the default reply." }],
    });
    let textDeltas = 0;
    for await (const event of result) if (event.type === "text_delta") textDeltas++;
    const elapsedMs = performance.now() - started;

    const scheduledMs = config.defaultOutputTokens * config.outputMsPerToken;
    expect(textDeltas).toBe(config.defaultOutputTokens);
    expect((await result.response).usage.outputTokens).toBe(config.defaultOutputTokens);
    expect(provider.stats.totalOutputMs).toBeCloseTo(scheduledMs);
    // Only sleeps shorter than 16 ms are skipped, so the stream can't finish earlier.
    expect(elapsedMs).toBeGreaterThan(scheduledMs - 20);
    // A timer per token cost ~10 ms each on Windows; this schedule needs about a dozen.
    expect(timers.mock.calls.length).toBeLessThan(config.defaultOutputTokens / 5);
  });
});
