// 11-registry-audit — baseline for item #3 (registry/compaction sizing).
// Deterministic code-inspection audit:
//   (a) models whose API-advertised window differs from a route-specific limit
//   (b) the exact chain: registry field → compaction budget → trigger
//   (c) what a "limit.input vs context window" distinction would change for the
//       5 most-used models
// Run from repo root:  node bench/baseline/11-registry-audit.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeResult, table, REPO_ROOT } from "./lib.mjs";

const CORE = await import(path.join(REPO_ROOT, "packages/gg-core/dist/index.js"));
const { MODELS, getContextWindow } = CORE;

// ── (a) Route-specific windows ───────────────────────────────
const routeSpecific = MODELS.filter((m) => m.codexContextWindow != null).map((m) => ({
  id: m.id,
  provider: m.provider,
  contextWindow: m.contextWindow,
  codexContextWindow: m.codexContextWindow,
  delta: m.contextWindow - m.codexContextWindow,
  apiRouteEffective: getContextWindow(m.id, { provider: m.provider }),
  codexRouteEffective: getContextWindow(m.id, { provider: m.provider, accountId: "acct_bench" }),
}));

const anthropicModels = MODELS.filter((m) => m.provider === "anthropic").map((m) => ({
  id: m.id,
  contextWindow: m.contextWindow,
  routeSpecificLimit: null, // registry has no Anthropic equivalent of codexContextWindow
}));

// Does gg-ai ever send Anthropic's 1M-context beta header? (Without it the
// default API route caps input at 200K for these models.)
const aiDist = readFileSync(path.join(REPO_ROOT, "packages/gg-ai/dist/index.js"), "utf8");
const aiSrcAnthropic = readFileSync(
  path.join(REPO_ROOT, "packages/gg-ai/src/providers/anthropic.ts"),
  "utf8",
);
const sends1mBeta = /context-1m|1m-2025|context_1m/i.test(aiDist) || /context-1m|1m-2025|context_1m/i.test(aiSrcAnthropic);

// ── (b) Compaction chain (code inspection, line refs) ────────
const compactionChain = [
  "model-registry.ts:567-574 getContextWindow(modelId,{provider,accountId}) — returns codexContextWindow ONLY when usesOpenAICodexTransport (provider==='openai' && accountId present, :549-551), else model.contextWindow; unknown model → 200_000 fallback. No clamping, no provenance tag, no input-vs-output distinction.",
  "agent-session.ts:1170-1187 (auto-compact in prompt()) — contextWindow = getContextWindow(this.model,{provider,accountId}); threshold = settingsManager.get('compactThreshold') (settings-manager.ts:9,66 — default 0.85, zod-bounded 0.1..1.0); shouldCompact(this.messages, contextWindow, threshold, activeTokens).",
  "active-context.ts (calculateActiveContextTokens) — when a provider usage anchor exists, actualTokens = last authoritative usage (inputTokens+cacheRead+cacheWrite) + estimated tokens of messages after the anchor; otherwise undefined.",
  "compactor.ts:180-201 shouldCompact — estimated = actualTokens ?? estimateConversationTokens(messages); limit = Math.ceil(contextWindow * threshold); triggers when estimated >= limit. Registry number drives the trigger DIRECTLY (×0.85).",
  "token-estimator.ts — estimateConversationTokens: per-message overhead 4 + chars/(family ratio: claude 3.2, gpt 3.7, glm 2.5, kimi 2.8, minimax 3.2, mimo 3.7, default 3.5), EMA-calibrated from provider usage (alpha 0.3, clamp 2.0..5.0).",
  "compactor.ts:756-760 (compact()) — summarizer budget = getContextWindow(summaryModel.id,{provider,accountId}) − MAX_SUMMARY_OUTPUT_TOKENS(4096, :28) − promptOverhead(1000); summaryModel from getSummaryModel (model-registry.ts:611-621: anthropic→claude-sonnet-5, openai/glm/deepseek→low-tier sibling, else current model). The SAME possibly-inflated registry window sizes the summarizer input budget.",
  "Other trigger call sites: useContextCompaction.ts:110,273 (UI), agent-session.ts:1306-1315 (overflow recovery bypasses cooldown), :1554, :2270-2276, serve-mode.ts:275,485, agent-home-mode.ts:336,564, interactive.ts:110-111 & cli.ts:709-710 (threshold 0.8), app-sidecar.ts:1517. All funnel through the same getContextWindow value.",
];

// ── (c) Impact for the 5 most-used models ────────────────────
const FIVE = ["claude-sonnet-5", "claude-opus-4-8", "gpt-5.6-sol", "gpt-5.5", "kimi-k3"];
const findings = FIVE.map((id) => {
  const m = MODELS.find((x) => x.id === id);
  const apiWindow = getContextWindow(id, { provider: m.provider });
  const routed = getContextWindow(id, { provider: m.provider, accountId: "acct_bench" });
  const trigger = Math.ceil(routed * 0.85);
  let overBudget = false;
  let note;
  if (m.provider === "anthropic") {
    // Registry says 1M; Anthropic's default route accepts 200K input unless the
    // 1M-context beta header is sent — and gg-ai never sends it.
    overBudget = m.contextWindow > 200_000 && !sends1mBeta;
    note = overBudget
      ? `registry contextWindow=${m.contextWindow.toLocaleString()} → trigger at ${trigger.toLocaleString()} tokens, but the default Anthropic route rejects >200K input and gg-ai sends no context-1m beta header. Auto-compaction can NEVER fire before the provider 400s ('prompt is too long') on accounts without 1M enabled — GG budgets against a number up to 5x larger than the route accepts.`
      : "within route limit";
  } else if (m.provider === "openai") {
    note =
      `API-key route budgets ${apiWindow.toLocaleString()} (matches the public Responses API 1.05M window — correct). ` +
      `Codex/ChatGPT-OAuth route correctly drops to ${routed.toLocaleString()} via codexContextWindow (trigger ${trigger.toLocaleString()}) — the ONE place a route-specific limit exists. ` +
      `But the distinction is transport-keyed (accountId), not input-limit-keyed: maxOutputTokens 128K is not reserved out of the trigger, and a limit.input field would additionally matter if OpenAI's per-request input cap < advertised window.`;
  } else {
    // kimi-k3
    note = `single window ${m.contextWindow.toLocaleString()} on both public and Kimi-For-Coding routes; maxOutputTokens=${m.maxOutputTokens.toLocaleString()} can equal/exceed half the window but the trigger ignores output reservation — a limit.input distinction would only matter if Moonshot's per-route input cap differs (none is modeled).`;
  }
  return {
    id: m.id,
    provider: m.provider,
    registryContextWindow: m.contextWindow,
    codexContextWindow: m.codexContextWindow ?? null,
    effectiveWindowUsedForCompaction: routed,
    compactionTriggerAt085: trigger,
    maxOutputTokens: m.maxOutputTokens,
    budgetsAgainstLargerThanRouteAccepts: overBudget,
    note,
  };
});

// ── Report ───────────────────────────────────────────────────
console.log("== 11-registry-audit ==\n(a) route-specific windows (codexContextWindow present):");
table(
  routeSpecific.map((r) => [r.id, r.contextWindow.toLocaleString(), r.codexContextWindow.toLocaleString(), r.apiRouteEffective.toLocaleString(), r.codexRouteEffective.toLocaleString()]),
  ["model", "API window", "codex window", "effective (API-key)", "effective (OAuth/codex)"],
);
console.log("\nAnthropic models (NO route-specific limit field exists):");
table(
  anthropicModels.map((m) => [m.id, m.contextWindow.toLocaleString(), "none"]),
  ["model", "contextWindow", "route limit"],
);
console.log(`\ngg-ai sends Anthropic 1M-context beta header: ${sends1mBeta}`);

console.log("\n(b) compaction chain:");
for (const link of compactionChain) console.log("  •", link);

console.log("\n(c) five most-used models:");
table(
  findings.map((f) => [
    f.id,
    f.registryContextWindow.toLocaleString(),
    f.effectiveWindowUsedForCompaction.toLocaleString(),
    f.compactionTriggerAt085.toLocaleString(),
    f.budgetsAgainstLargerThanRouteAccepts ? "YES" : "no",
  ]),
  ["model", "registry window", "compaction window", "trigger @0.85", "over-budget vs route"],
);

const summary =
  `Registry: ${routeSpecific.length} OpenAI models carry codexContextWindow (1_050_000 API vs 272_000 Codex product route) — the only route-specific limits in the registry, keyed off accountId presence. ` +
  `No Anthropic model has any route-specific or input-limit distinction: claude-sonnet-5 / claude-opus-4-8 / claude-fable-5 list contextWindow=1_000_000, and gg-ai never sends the context-1m beta header, so on the default 200K route compaction is budgeted against a number 5x larger than the provider accepts (trigger 850K ≫ 200K hard reject). ` +
  `Chain: registry.contextWindow (or codexContextWindow) → getContextWindow(provider,accountId) → shouldCompact limit = ceil(window × compactThreshold 0.85) using provider-anchored actualTokens or chars/ratio estimates → compact() sizes the summarizer input budget off the SAME window minus 4096+1000. ` +
  `There is no clamping, no provenance, and no output-token reservation anywhere in the chain. A limit.input field would change budgeting for Sonnet 5 / Opus 4.8 (1M→200K on the default route) and leave gpt-5.6-sol / gpt-5.5 / kimi-k3 unchanged on their primary routes.`;

console.log("\nsummary:", summary);
writeResult("11-registry-audit", {
  sendsAnthropic1mBetaHeader: sends1mBeta,
  models: MODELS.map((m) => ({
    id: m.id,
    provider: m.provider,
    contextWindow: m.contextWindow,
    codexContextWindow: m.codexContextWindow ?? null,
    maxOutputTokens: m.maxOutputTokens,
  })),
  routeSpecificWindows: routeSpecific,
  compactionChain,
  findings,
  summary,
});
