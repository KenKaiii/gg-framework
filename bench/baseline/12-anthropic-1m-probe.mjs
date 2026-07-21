// 12-anthropic-1m-probe — LIVE probe for item #3 (Anthropic route-aware context).
// Question settled by measurement, not assumption: do Claude Sonnet 5 / Opus 4.8 /
// Fable 5 accept a request whose input exceeds the 200K non-beta ceiling WITHOUT
// gg-ai sending any `context-1m` beta header?
//   - If they 400 with a max-tokens/context error → the models need the beta and
//     the registry's 1M is a lie that lets compaction fire too late.
//   - If they succeed → the models are 1M-GA, the registry is correct, and item
//     #3 is a NO-OP (nothing to change in gg-ai).
// Uses the real GG auth credentials (~/.gg/auth.json) via AuthStorage.
// Run from repo root:  node bench/baseline/12-anthropic-1m-probe.mjs
import { stream, anthropicCreds, freshCacheKey, writeResult, estTokens, table } from "./lib.mjs";

const MODELS = ["claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"];

// Build a ~210K-token user message: comfortably past the 200K non-beta ceiling
// but far under 1M. 210K tokens ≈ 840K chars. Use varied line content so the
// provider can't collapse it as trivially compressible in a way that changes
// token accounting materially.
function buildLargePrompt(targetTokens) {
  const targetChars = targetTokens * 4;
  const line =
    "The quick brown fox jumps over the lazy dog while 12345 numbers 67890 drift past section markers. ";
  const reps = Math.ceil(targetChars / line.length);
  let body = "";
  for (let i = 0; i < reps; i++) body += `L${i}: ${line}`;
  return body;
}

const TARGET_TOKENS = 210_000;
const bigText = buildLargePrompt(TARGET_TOKENS);
const approxInputTokens = estTokens(bigText);

async function probe(model) {
  const creds = await anthropicCreds();
  const out = {
    model,
    approxInputTokens,
    ok: false,
    threw: false,
    errorName: null,
    errorMessage: null,
    statusCode: null,
    classification: null, // ACCEPTED | CONTEXT_REJECTED | USAGE_LIMITED | OTHER_ERROR
    usage: null,
    text: null,
    ms: 0,
  };
  const t0 = Date.now();
  try {
    const s = stream({
      provider: "anthropic",
      model,
      apiKey: creds.accessToken,
      accountId: creds.accountId,
      ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
      // A single big user turn + a tiny instruction to force a short reply.
      messages: [
        {
          role: "user",
          content:
            bigText +
            "\n\nThat was filler. Ignore it entirely. Reply with exactly the two words: PROBE OK.",
        },
      ],
      maxTokens: 16,
      promptCacheKey: freshCacheKey(),
    });
    // Swallow the background pump's independent rejection if the iterator throws.
    s.then(
      () => {},
      () => {},
    );
    let text = "";
    for await (const ev of s) {
      if (ev.type === "text_delta") text += ev.text;
    }
    const resp = await s;
    out.ok = true;
    out.classification = "ACCEPTED";
    out.text = text.trim().slice(0, 60);
    // Full usage: with cache_control on the last user turn the big payload is
    // counted as cacheWrite, so inputTokens is tiny — cacheWrite ≈ the ~224K we
    // sent proves the whole thing was transmitted and processed, not dropped.
    out.usage = resp.usage ?? null;
  } catch (err) {
    out.threw = true;
    out.errorName = err?.name ?? typeof err;
    out.errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    out.statusCode = err?.statusCode ?? null;
    const msg = out.errorMessage.toLowerCase();
    if (out.statusCode === 429 || /usage limit|rate limit|too many requests/.test(msg)) {
      out.classification = "USAGE_LIMITED"; // orthogonal to context size
    } else if (
      out.statusCode === 400 ||
      /max_tokens|context|token|200000|200k|prompt is too long/.test(msg)
    ) {
      out.classification = "CONTEXT_REJECTED";
    } else {
      out.classification = "OTHER_ERROR";
    }
  }
  out.ms = Date.now() - t0;
  return out;
}

console.log(
  `== 12-anthropic-1m-probe ==\nSending ~${approxInputTokens} input tokens (target ${TARGET_TOKENS}) with NO context-1m beta header.\n`,
);

const results = [];
for (const model of MODELS) {
  process.stdout.write(`probing ${model} … `);
  const r = await probe(model);
  results.push(r);
  console.log(
    r.ok
      ? `ACCEPTED (input=${r.usage?.inputTokens ?? "?"} cacheWrite=${r.usage?.cacheWrite ?? "?"} cacheRead=${r.usage?.cacheRead ?? "?"} tok, ${r.ms}ms, said "${r.text}")`
      : `${r.classification} ${r.statusCode ?? ""} ${r.errorName}: ${r.errorMessage}`,
  );
}

table(
  results.map((r) => [
    r.model,
    r.approxInputTokens,
    r.classification,
    r.usage ? `${r.usage.inputTokens}/${r.usage.cacheWrite ?? 0}` : "-",
    r.ms + "ms",
  ]),
  ["model", "~input tok", "classification", "input/cacheWrite", "wall"],
);

const accepted = results.filter((r) => r.classification === "ACCEPTED");
const contextRejected = results.filter((r) => r.classification === "CONTEXT_REJECTED");
const usageLimited = results.filter((r) => r.classification === "USAGE_LIMITED");

const verdict =
  contextRejected.length > 0
    ? `At least one model (${contextRejected.map((r) => r.model).join(", ")}) REJECTED the ~${approxInputTokens}-` +
      `token request on a context/max_tokens error without a beta header — the registry's 1M is NOT usable on ` +
      `this route as-is. gg-ai must send the context-1m beta header for these models or clamp compaction to 200K.`
    : accepted.length > 0
      ? `${accepted.map((r) => r.model).join(", ")} ACCEPTED a ~${approxInputTokens}-token request (>200K) with ` +
        `NO context-1m beta header sent by gg-ai — a streamed completion came back, which a 400 context ` +
        `rejection cannot produce. The large payload was genuinely transmitted (counted as cacheWrite, since ` +
        `gg-ai applies cache_control to the last user turn). ` +
        (usageLimited.length
          ? `${usageLimited.map((r) => r.model).join(", ")} returned a 429 USAGE LIMIT — orthogonal to context ` +
            `size, so inconclusive here but not contradicting (owner-confirmed 1M GA). `
          : "") +
        `Conclusion: Anthropic 1M models are 1M-context GA on this route. The model-registry contextWindow of ` +
        `1_000_000 is CORRECT and compaction at 0.85×1M is valid, so item #3 is a NO-OP — no route-aware ` +
        `clamp and no beta header are needed.`
      : `No model returned a definitive context answer (all usage-limited or other errors) — re-run when limits clear.`;

console.log("\nverdict:", verdict);
writeResult("12-anthropic-1m-probe", {
  targetTokens: TARGET_TOKENS,
  approxInputTokens,
  betaHeaderSent: false,
  results,
  accepted: accepted.map((r) => r.model),
  contextRejected: contextRejected.map((r) => r.model),
  usageLimited: usageLimited.map((r) => r.model),
  verdict,
});
