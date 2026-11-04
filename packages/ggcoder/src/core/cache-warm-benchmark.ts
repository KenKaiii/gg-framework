/**
 * Prompt-cache warming micro-benchmark — isolates the cache effect.
 *
 * The existing api-benchmark grows the conversation each turn and uses a tiny
 * (~250 token) system prompt, which is BELOW Anthropic's minimum cacheable
 * prefix (512 tok on current Claude models, up to 4096 on older ones) — so caching never engages and the
 * A/B is dominated by turn-to-turn throughput variance.
 *
 * This test uses a large, FIXED prefix (well above the min) and a tiny variable
 * suffix, then measures, per arm:
 *   COLD  — fresh cache key, first hit (cache WRITE, no read).
 *   WARM  — prewarm the prefix, then measure the next call's cache_read + TTFT.
 *
 * It reports cache_read tokens and TTFT directly, so the cache effect is visible
 * regardless of throughput noise.
 *
 * Usage: npx tsx src/core/cache-warm-benchmark.ts
 * Env:   GG_CW_PROVIDER (default anthropic), GG_CW_MODEL (default claude-haiku-5-5),
 *        GG_CW_REPS (default 4)
 */

import { stream, type Message, type StreamEvent, type Usage } from "@kleio/ai";
import { AuthStorage } from "./auth-storage.js";

/** Build a large, realistic coding-agent system prompt (~well above 2048 tok). */
function bigPrefix(): string {
  const toolDoc = (name: string, desc: string) =>
    `### ${name}\n${desc}\nParameters are validated with a Zod schema and converted to JSON Schema at the provider boundary. ` +
    `Errors are returned as structured tool results so the agent can self-correct in the same turn. `;
  const tools = [
    toolDoc(
      "read",
      "Read a file's contents with cat -n style numbered lines, truncated to 2000 lines or 50KB.",
    ),
    toolDoc(
      "write",
      "Write content to a file, creating parent directories. Existing files must be read first.",
    ),
    toolDoc(
      "edit",
      "Replace text via search/replace blocks applied sequentially with a fuzzy fallback ladder.",
    ),
    toolDoc(
      "bash",
      "Execute a shell command in a non-interactive bash shell with combined stdout/stderr.",
    ),
    toolDoc("grep", "Search file contents using regex, returning filepath:line:content matches."),
    toolDoc("find", "Find files matching a glob pattern, respecting .gitignore."),
    toolDoc("ls", "List directory contents with file types and sizes."),
    toolDoc("web_fetch", "Fetch and read web page content as Markdown, extracting main content."),
    toolDoc(
      "subagent",
      "Spawn an isolated sub-agent with its own context window for a focused task.",
    ),
    toolDoc("task_output", "Read new output from a background process by id."),
  ];
  // Repeat the tool block several times so the prefix clears Anthropic's
  // minimum cacheable size (512 tok on current Claude models, up to 4096 on
  // older ones) with headroom.
  const bulkTools: string[] = [];
  for (let r = 0; r < 22; r++)
    bulkTools.push(...tools, `<!-- tool block repetition ${r} for prefix sizing -->`);
  return [
    "You are GG Coder — a coding agent that works directly in the user's codebase.",
    "You explore, understand, change, and verify code end-to-end.",
    "",
    "## How to Talk",
    "Lead with the outcome. One idea per line. Bottom line first. No preamble or recap.",
    "Stay silent between tool calls unless you hit a decision, tradeoff, or question.",
    "",
    "## How to Work",
    "Read before edit/write; re-read after formatters, codegen, or any disk mutator.",
    "Match neighbouring code style. Keep edits small; plan multi-file work first.",
    "Choose targeted verification appropriate to the change; read and fix failures.",
    "Do not assume APIs, CLI flags, config schema, or error wording — verify against source.",
    "",
    "## Tools",
    ...bulkTools,
    "",
    "## Code Quality",
    "Intent-revealing names; reuse existing deps. Types first; handle I/O, input, and external API errors.",
    "No dead or commented-out code, placeholders, or unasked refactors.",
    "",
    "## Environment",
    "Working directory: /home/user/project. Platform: darwin.",
  ].join("\n");
}

interface CallMetrics {
  ttftMs: number;
  wallMs: number;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  outputTokens: number;
}

async function call(
  cfg: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
    accountId?: string;
  },
  system: string,
  user: string,
  promptCacheKey: string,
  cacheRetention: "short" | "long",
): Promise<CallMetrics> {
  const messages: Message[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const start = Date.now();
  let ttftMs = 0;
  let first = true;
  const result = stream({
    provider: cfg.provider as never,
    model: cfg.model,
    messages,
    maxTokens: 16,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    accountId: cfg.accountId,
    promptCacheKey,
    cacheRetention,
  });
  for await (const event of result as AsyncIterable<StreamEvent>) {
    if (first && (event.type === "text_delta" || event.type === "thinking_delta")) {
      ttftMs = Date.now() - start;
      first = false;
    }
  }
  const response: { message: Message; usage: Usage; stopReason: string } = await result.response;
  return {
    ttftMs: ttftMs || Date.now() - start,
    wallMs: Date.now() - start,
    inputTokens: response.usage.inputTokens,
    cacheRead: response.usage.cacheRead ?? 0,
    cacheWrite: response.usage.cacheWrite ?? 0,
    outputTokens: response.usage.outputTokens,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const provider = process.env.GG_CW_PROVIDER ?? "anthropic";
  const model = process.env.GG_CW_MODEL ?? "claude-haiku-5-5";
  const reps = parseInt(process.env.GG_CW_REPS ?? "4", 10);

  const auth = new AuthStorage();
  await auth.load();
  const c = await auth.resolveCredentials(provider);
  const cfg = {
    provider,
    model,
    apiKey: c.accessToken,
    baseUrl: c.baseUrl,
    accountId: c.accountId,
  };

  const system = bigPrefix();
  // Rough token size of the prefix (chars/3.3) for context.
  console.log(`\n🔥 Cache-warm micro-benchmark: ${provider}/${model}`);
  console.log(`   Prefix ~${Math.round(system.length / 3.3)} tokens, ${reps} reps per arm\n`);

  // ── COLD arm: every rep uses a UNIQUE cache key → never reads cache ──
  console.log("▶ COLD (no warming — fresh cache key each call):");
  // Each cold rep gets UNIQUE prefix content (Anthropic caches by content, not
  // by key) so every call is a true cache miss — otherwise rep 2+ would read
  // rep 1's cache and pollute the cold baseline.
  const cold: CallMetrics[] = [];
  for (let i = 0; i < reps; i++) {
    const uniqueSystem = `<!-- cold-sample-${Date.now()}-${i} -->\n${system}`;
    const m = await call(
      cfg,
      uniqueSystem,
      `Question ${i}: name one tool.`,
      `cold-${Date.now()}-${i}`,
      "short",
    );
    cold.push(m);
    console.log(
      `   rep ${i + 1}: TTFT ${m.ttftMs}ms | in ${m.inputTokens} | cacheRead ${m.cacheRead} | cacheWrite ${m.cacheWrite}`,
    );
    await sleep(1500);
  }

  await sleep(3000);

  // ── WARM arm: prewarm a SHARED key, then measure subsequent calls (cache reads) ──
  console.log("\n▶ WARM (prewarm shared prefix, then measure cache reads):");
  const warmKey = `warm-${Date.now()}`;
  // Prewarm: a throwaway call that writes the cache.
  const pw = await call(cfg, system, "warm.", warmKey, "long");
  console.log(`   prewarm: cacheWrite ${pw.cacheWrite} (cache primed)`);
  await sleep(1500);
  const warm: CallMetrics[] = [];
  for (let i = 0; i < reps; i++) {
    const m = await call(cfg, system, `Question ${i}: name one tool.`, warmKey, "long");
    warm.push(m);
    console.log(
      `   rep ${i + 1}: TTFT ${m.ttftMs}ms | in ${m.inputTokens} | cacheRead ${m.cacheRead} | cacheWrite ${m.cacheWrite}`,
    );
    await sleep(1500);
  }

  const avg = (xs: CallMetrics[], f: (m: CallMetrics) => number) =>
    xs.reduce((s, m) => s + f(m), 0) / xs.length;
  const coldTtft = avg(cold, (m) => m.ttftMs);
  const warmTtft = avg(warm, (m) => m.ttftMs);
  const coldRead = avg(cold, (m) => m.cacheRead);
  const warmRead = avg(warm, (m) => m.cacheRead);

  console.log("\n══════════════════════ RESULTS ══════════════════════");
  console.log(`Avg cacheRead tokens : cold ${coldRead.toFixed(0)}  →  warm ${warmRead.toFixed(0)}`);
  console.log(
    `Avg TTFT             : cold ${coldTtft.toFixed(0)}ms  →  warm ${warmTtft.toFixed(0)}ms  ` +
      `(${coldTtft > warmTtft ? "-" : "+"}${Math.abs(((coldTtft - warmTtft) / coldTtft) * 100).toFixed(0)}%)`,
  );
  const warmHitRate = warm.filter((m) => m.cacheRead > 0).length / warm.length;
  console.log(`Warm cache hit rate  : ${(warmHitRate * 100).toFixed(0)}%`);
  console.log(
    `Verdict: ${warmRead > 0 ? "caching ENGAGES when prefix exceeds the min — warming converts cold writes to reads" : "caching did NOT engage (prefix below provider minimum, or OAuth path strips cache_control)"}`,
  );
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
