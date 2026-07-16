#!/usr/bin/env node
// Verify prompt caching across providers using ~/.gg/auth.json credentials.
//
// Strategy: for each provider, fire two identical requests with a long shared
// prefix. The second request should report cacheRead > 0 if caching works.
// We use a stable promptCacheKey across the two calls so providers that route
// by key (OpenAI Chat, OpenAI Codex, Moonshot) can hit the same shard.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stream } from "../packages/gg-ai/dist/index.js";

const AUTH_PATH = join(homedir(), ".gg", "auth.json");
const auth = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));

// Pad with enough text to clear OpenAI's ~1024-token minimum prefix.
const PADDING = "All work and no play makes Jack a dull boy. ".repeat(400);
const SYSTEM = `You are a careful, terse assistant. Context: ${PADDING}`;
const USER = "Reply with exactly the word: ack";

const CACHE_KEY = `verify-caching-${Date.now()}`;

const TARGETS = [
  {
    name: "anthropic / claude-opus-4-8",
    options: () => ({
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKey: auth.anthropic.accessToken,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
      maxTokens: 32,
      cacheRetention: "short",
      promptCacheKey: CACHE_KEY,
    }),
  },
  {
    name: "openai-codex / gpt-5.5",
    options: () => ({
      provider: "openai",
      model: "gpt-5.5",
      apiKey: auth.openai.accessToken,
      accountId: auth.openai.accountId,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
      maxTokens: 32,
      cacheRetention: "short",
      promptCacheKey: CACHE_KEY,
    }),
  },
  {
    name: "moonshot / kimi-k3",
    options: () => ({
      provider: "moonshot",
      model: "kimi-k3",
      apiKey: auth.moonshot.accessToken,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
      maxTokens: 32,
      cacheRetention: "short",
      promptCacheKey: CACHE_KEY,
    }),
  },
  {
    name: "deepseek / deepseek-chat",
    options: () => ({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: auth.deepseek.accessToken,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
      maxTokens: 32,
      cacheRetention: "short",
    }),
  },
  {
    name: "glm / glm-5.1",
    options: () => ({
      provider: "glm",
      model: "glm-5.1",
      apiKey: auth.glm.accessToken,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
      maxTokens: 32,
      cacheRetention: "short",
    }),
  },
  {
    name: "minimax / MiniMax-M2.7",
    options: () => ({
      provider: "minimax",
      model: "MiniMax-M2.7",
      apiKey: auth.minimax.accessToken,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
      maxTokens: 32,
      cacheRetention: "short",
      promptCacheKey: CACHE_KEY,
    }),
  },
  {
    name: "xiaomi / mimo-v2.5-pro",
    options: () => ({
      provider: "xiaomi",
      model: "mimo-v2.5-pro",
      apiKey: auth.xiaomi.accessToken,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
      maxTokens: 32,
      cacheRetention: "short",
    }),
  },
  {
    name: "openrouter / qwen/qwen3.6-plus",
    options: () => ({
      provider: "openrouter",
      model: "qwen/qwen3.6-plus",
      apiKey: auth.openrouter.accessToken,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
      maxTokens: 32,
      cacheRetention: "short",
    }),
  },
];

async function runOnce(label, optionsFactory) {
  const t0 = Date.now();
  const opts = optionsFactory();
  try {
    const result = stream({ ...opts, streaming: false });
    const response = await result;
    const usage = response.usage ?? {};
    const ms = Date.now() - t0;
    return {
      label,
      ms,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
    };
  } catch (err) {
    return {
      label,
      ms: Date.now() - t0,
      error: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err),
    };
  }
}

function fmt(n) {
  return n.toString().padStart(6);
}

for (const target of TARGETS) {
  console.log(`\n── ${target.name} ──────────────────────────────`);
  const first = await runOnce("first ", target.options);
  if (first.error) {
    console.log(`  first : ERROR ${first.error}`);
    continue;
  }
  console.log(
    `  first : in=${fmt(first.inputTokens)} out=${fmt(first.outputTokens)} cacheRead=${fmt(first.cacheRead)} ${first.ms}ms`,
  );
  // Brief delay to let the cache settle
  await new Promise((r) => setTimeout(r, 1500));
  const second = await runOnce("second", target.options);
  if (second.error) {
    console.log(`  second: ERROR ${second.error}`);
    continue;
  }
  console.log(
    `  second: in=${fmt(second.inputTokens)} out=${fmt(second.outputTokens)} cacheRead=${fmt(second.cacheRead)} ${second.ms}ms`,
  );
  const hit = second.cacheRead > 0 ? "✓ CACHE HIT" : "✗ no cache hit";
  console.log(`  → ${hit}`);
}

console.log("\nDone.");
