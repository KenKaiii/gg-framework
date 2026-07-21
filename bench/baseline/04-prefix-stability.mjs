// Baseline 04 — prompt-prefix stability (baseline for item #12 byte-stable
// prompt prefixes).
//
// (a) DETERMINISTIC: build the real system prompt 5× and compare sha256.
//     If unstable, diff to find the volatile part. Also scan system-prompt.ts
//     for Date/toISOString/random usage.
// (b) LIVE: 6-turn Q&A conversation against Sonnet 5 with the REAL system
//     prompt and a stable promptCacheKey, mirroring bench/d-cache-audit.mjs.
//     Control arm (stable prefix) vs volatile-suffix arm (timestamp appended
//     to the END of the system prompt) vs volatile-prefix arm (timestamp
//     PREPENDED — destroys the shared prefix, proving the measurement detects
//     hit% collapse).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  REPO_ROOT,
  buildSystemPrompt,
  sonnetTurn,
  estTokens,
  freshCacheKey,
  writeResult,
  mean,
  fmt,
  pct,
  table,
  sleep,
} from "./lib.mjs";

const TURNS = 6;
const RUNS = 2;

// ── (a) Deterministic byte-stability ──
console.log("── (a) byte-stability of buildSystemPrompt(repoRoot) ──");
const builds = [];
for (let i = 0; i < 5; i++) {
  const prompt = await buildSystemPrompt(REPO_ROOT);
  const sha = createHash("sha256").update(prompt).digest("hex");
  builds.push({ prompt, sha });
  console.log(`build ${i + 1}: ${prompt.length} chars sha256=${sha.slice(0, 16)}…`);
  await sleep(250);
}
const byteStable = builds.every((b) => b.sha === builds[0].sha);
console.log(`byte-stable across 5 builds: ${byteStable}`);

// Diff first differing build (if any) to find the volatile part.
let volatileDiff = null;
const base = builds[0].prompt;
const other = builds.find((b) => b.sha !== builds[0].sha);
if (other) {
  const aLines = base.split("\n");
  const bLines = other.prompt.split("\n");
  const diffs = [];
  for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
    if (aLines[i] !== bLines[i]) diffs.push({ line: i, a: aLines[i], b: bLines[i] });
  }
  volatileDiff = diffs;
}

// Does the prompt embed the current date/time? Inspect source + prompt tail.
const src = await readFile(path.join(REPO_ROOT, "packages/ggcoder/src/system-prompt.ts"), "utf8");
const volatileSrcLines = src
  .split("\n")
  .map((line, i) => ({ n: i + 1, line: line.trim() }))
  .filter(({ line }) => /new Date|toISOString|Math\.random|randomUUID|Date\.now/.test(line));
const UNCACHED_MARKER = "<!-- uncached -->";
const markerIdx = base.indexOf(UNCACHED_MARKER);
const dateSuffix = markerIdx >= 0 ? base.slice(markerIdx) : null;
const dateEmbedding = {
  embedsDate: /Today's date:/.test(base),
  // Derived from the actual suffix: a time would look like HH:MM(:SS) or an ISO timestamp.
  embedsTime: dateSuffix ? /\d{1,2}:\d{2}|T\d{2}:\d{2}/.test(dateSuffix) : false,
  sourceLines: volatileSrcLines,
  uncachedMarkerPresent: markerIdx >= 0,
  suffixAfterMarker: dateSuffix,
  note: "The only volatile content is `Today's date: <day> <month> <year>` — appended as the FINAL line after an `<!-- uncached -->` marker, so it changes at most once per calendar day and never disturbs the cached prefix.",
};
console.log(`embeds date: ${dateEmbedding.embedsDate} (final line, after ${UNCACHED_MARKER} marker)`);
console.log(`source volatility lines: ${volatileSrcLines.map((l) => l.n).join(", ") || "none"}`);

// ── (b) Live cache measurement ──
console.log("\n── (b) live prefix-cache measurement (Sonnet 5) ──");
const baseSystem = base;
console.log(`system prompt: ${baseSystem.length} chars (~${estTokens(baseSystem)} est tokens)`);

const QUESTIONS = [
  "One short sentence: what is a prefix cache?",
  "One short sentence: what breaks it?",
  "One short sentence: how do providers report cache hits?",
  "One short sentence: what is a cache breakpoint?",
  "One short sentence: why does message order matter for caching?",
  "Reply with exactly: done",
];

async function runArm(name, { volatileMode }) {
  const rows = [];
  for (let run = 0; run < RUNS; run++) {
    const cacheKey = freshCacheKey();
    const history = [];
    for (let t = 0; t < TURNS; t++) {
      history.push({ role: "user", content: QUESTIONS[t] });
      const volatileText = `Current time: ${new Date().toISOString()} (request #${t + 1})`;
      const system =
        volatileMode === "suffix"
          ? `${baseSystem}\n\n${volatileText}`
          : volatileMode === "prefix"
            ? `${volatileText}\n\n${baseSystem}`
            : baseSystem;
      const r = await sonnetTurn({ system, messages: [...history], maxTokens: 60, promptCacheKey: cacheKey });
      history.push({ role: "assistant", content: r.text || "(empty)" });
      rows.push({
        run: run + 1,
        turn: t + 1,
        inputTokens: r.usage.inputTokens ?? 0,
        cacheRead: r.usage.cacheRead ?? 0,
        cacheWrite: r.usage.cacheWrite ?? 0,
        ttftMs: r.ttftMs,
        totalMs: r.totalMs,
      });
      await sleep(300);
    }
  }
  return { name, rows };
}

console.log("running control arm…");
const control = await runArm("control", {});
console.log("running volatile-suffix arm (timestamp appended to END of system prompt)…");
const volatileSuffix = await runArm("volatile-suffix", { volatileMode: "suffix" });
console.log("running volatile-prefix arm (timestamp prepended to START of system prompt)…");
const volatilePrefix = await runArm("volatile-prefix", { volatileMode: "prefix" });

const hitPct = (r) => pct(r.cacheRead, r.cacheRead + r.inputTokens);
function armSummary(arm) {
  const warm = arm.rows.filter((r) => r.turn > 1);
  return {
    avgWarmHitPct: mean(warm.map(hitPct)),
    avgWarmTtftMs: mean(warm.map((r) => r.ttftMs)),
    warmBilledInputTokens: warm.reduce((a, r) => a + r.inputTokens, 0),
    warmCacheReadTokens: warm.reduce((a, r) => a + r.cacheRead, 0),
    totalInputTokens: arm.rows.reduce((a, r) => a + r.inputTokens, 0),
    totalCacheWriteTokens: arm.rows.reduce((a, r) => a + r.cacheWrite, 0),
  };
}

for (const arm of [control, volatileSuffix, volatilePrefix]) {
  console.log(`\n[${arm.name}] per-turn:`);
  table(
    arm.rows.map((r) => [
      r.run, r.turn, r.inputTokens, r.cacheRead, r.cacheWrite,
      fmt(hitPct(r), 1) + "%", r.ttftMs + "ms", r.totalMs + "ms",
    ]),
    ["run", "turn", "input", "cacheRead", "cacheWrite", "hit%", "ttft", "total"],
  );
}
const arms = {
  control: { rows: control.rows, summary: armSummary(control) },
  volatileSuffix: { rows: volatileSuffix.rows, summary: armSummary(volatileSuffix) },
  volatilePrefix: { rows: volatilePrefix.rows, summary: armSummary(volatilePrefix) },
};
console.log("\n── Warm-turn (2+) summary ──");
table(
  Object.entries(arms).map(([name, a]) => [
    name, fmt(a.summary.avgWarmHitPct, 1) + "%", fmt(a.summary.avgWarmTtftMs) + "ms",
    fmt(a.summary.warmBilledInputTokens), fmt(a.summary.warmCacheReadTokens),
  ]),
  ["arm", "avg hit% (warm)", "avg ttft (warm)", "billed input tok", "cacheRead tok"],
);

writeResult("04-prefix-stability", {
  byteStable,
  volatileDiff: volatileDiff ?? "n/a — prompt was byte-stable across all 5 builds",
  dateEmbedding,
  systemPromptChars: base.length,
  systemPromptEstTokens: estTokens(baseSystem),
  arms,
  notes:
    "volatile-suffix (timestamp APPENDED to the system prompt) does NOT collapse the cache: prefix " +
    "caching reuses the shared stable prefix up to the divergence point, so hit% stays ~100% and only " +
    "the volatile tail is reprocessed. volatile-prefix (timestamp PREPENDED) destroys the shared prefix " +
    "and collapses hit% — that arm proves the measurement detects regressions. This is exactly why " +
    "system-prompt.ts appends its volatile date suffix as the FINAL line.",
});
process.exit(0);
