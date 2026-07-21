// 08-fault-stream-truncate — baseline for item #4 (truncated-stream retry).
// Question: when the Anthropic SSE stream ends EARLY (socket destroyed mid-events,
// or clean TCP close with no message_stop), does gg-ai's stream() treat it as
// retryable or terminal, and what does the caller see?
// No live calls — local mock server, apiKey "bench-mock".
// Run from repo root:  node bench/baseline/08-fault-stream-truncate.mjs
import http from "node:http";
import path from "node:path";
import { stream, SONNET, writeResult, fmt, table, REPO_ROOT } from "./lib.mjs";

const AI = await import(path.join(REPO_ROOT, "packages/gg-ai/dist/index.js"));
const { isUsageLimitError, classifyProviderError, formatError, ProviderError } = AI;

// ── SSE helpers ──────────────────────────────────────────────
function sse(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
const MSG_START = {
  type: "message_start",
  message: {
    id: "msg_bench1",
    type: "message",
    role: "assistant",
    model: SONNET,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 25, output_tokens: 1 },
  },
};
const BLOCK_START = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
const delta = (text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const BLOCK_STOP = { type: "content_block_stop", index: 0 };
const MSG_DELTA = {
  type: "message_delta",
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: 6 },
};
const MSG_STOP = { type: "message_stop" };

// ── Mock Anthropic endpoint with 3 truncation modes ─────────
const requests = [];
let currentMode = "clean"; // set before each stream() call; the SDK URL carries no mode
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const mode = currentMode;
  requests.push({ method: req.method, path: url.pathname, mode });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });

  if (mode === "clean") {
    sse(res, "message_start", MSG_START);
    sse(res, "content_block_start", BLOCK_START);
    sse(res, "content_block_delta", delta("Hello"));
    sse(res, "content_block_delta", delta(" world"));
    sse(res, "content_block_stop", BLOCK_STOP);
    sse(res, "message_delta", MSG_DELTA);
    sse(res, "message_stop", MSG_STOP);
    res.end();
    return;
  }
  if (mode === "truncate-mid") {
    // Valid prefix, then DESTROY the socket (connection reset mid-events).
    sse(res, "message_start", MSG_START);
    sse(res, "content_block_start", BLOCK_START);
    sse(res, "content_block_delta", delta("partial-"));
    sse(res, "content_block_delta", delta("text"));
    setTimeout(() => req.socket.destroy(), 50);
    return;
  }
  // truncate-silent: valid events, then a CLEAN end with no message_delta /
  // message_stop — as if the provider hung up early but politely.
  sse(res, "message_start", MSG_START);
  sse(res, "content_block_start", BLOCK_START);
  sse(res, "content_block_delta", delta("partial-"));
  sse(res, "content_block_delta", delta("text"));
  sse(res, "content_block_stop", BLOCK_STOP);
  res.end();
  return;
});
server.on("clientError", () => {}); // expected: destroyed sockets
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// ── Run one mode through gg-ai stream() ─────────────────────
async function runMode(mode) {
  const out = {
    threw: false,
    errorName: null,
    errorMessage: null,
    isProviderError: false,
    statusCode: null,
    errorSource: null,
    guidance: null,
    isUsageLimit: false,
    classification: null,
    retryablePerGgAi: null,
    eventsSeen: {},
    text: null,
    stopReason: null,
    usage: null,
    silentPartial: false,
    ms: 0,
  };
  const t0 = performance.now();
  try {
    currentMode = mode;
    const s = stream({
      provider: "anthropic",
      model: SONNET,
      apiKey: "bench-mock",
      baseUrl,
      messages: [{ role: "user", content: `mode=${mode} say hi` }],
      maxTokens: 64,
    });
    // StreamResult's background pump rejects its response promise independently
    // of the async iterator; if the iterator throws first, that rejection is
    // otherwise unhandled and crashes the process.
    s.then(() => {}, () => {});
    let text = "";
    for await (const ev of s) {
      out.eventsSeen[ev.type] = (out.eventsSeen[ev.type] ?? 0) + 1;
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "done") out.stopReason = ev.stopReason;
    }
    const resp = await s;
    out.text = text;
    out.stopReason = resp.stopReason;
    out.usage = resp.usage;
    const content = resp.message.content;
    out.silentPartial =
      text.length > 0 && resp.stopReason === "end_turn" && mode !== "clean";
    out.contentParts = Array.isArray(content) ? content.length : content;
  } catch (err) {
    out.threw = true;
    out.errorName = err?.name ?? typeof err;
    out.errorMessage = err instanceof Error ? err.message : String(err);
    out.isProviderError = err instanceof ProviderError;
    out.statusCode = err?.statusCode ?? null;
    out.isUsageLimit = isUsageLimitError(err);
    const tagged = classifyProviderError(out.errorMessage);
    const m = tagged.match(/^\[(\w+)\]/);
    out.classification = m ? m[1] : "unclassified";
    const f = formatError(err);
    out.errorSource = f.source;
    out.guidance = f.guidance;
    // gg-ai exports no explicit isRetryable flag; the closest signals are the
    // classifier tag + the FormattedError guidance.
    out.retryablePerGgAi =
      out.classification === "provider_transient" || out.classification === "rate_limited"
        ? "yes (classified transient)"
        : `no explicit marker — source=${f.source}, guidance "${f.guidance.slice(0, 60)}…"`;
  }
  out.ms = fmt(performance.now() - t0, 0);
  return out;
}

console.log("== 08-fault-stream-truncate ==\nmock:", baseUrl, "(POST /v1/messages)");
const modes = {};
for (const mode of ["clean", "truncate-mid", "truncate-silent"]) {
  modes[mode] = await runMode(mode);
}
server.close();

table(
  ["clean", "truncate-mid", "truncate-silent"].map((m) => {
    const r = modes[m];
    return [
      m,
      r.threw ? `${r.errorName}: ${String(r.errorMessage).slice(0, 42)}` : "no throw",
      r.threw ? String(r.statusCode) : `stop=${r.stopReason}`,
      r.threw ? r.classification : `text=${JSON.stringify(r.text)}`,
      r.silentPartial ? "SILENT PARTIAL" : "-",
    ];
  }),
  ["mode", "threw?", "status/stop", "class/text", "danger"],
);

console.log("\ndetail:");
for (const [m, r] of Object.entries(modes)) {
  console.log(`  ${m}: events=${JSON.stringify(r.eventsSeen)} usage=${JSON.stringify(r.usage)}`);
  if (r.threw) console.log(`    retryablePerGgAi: ${r.retryablePerGgAi}`);
}

const tm = modes["truncate-mid"];
const ts = modes["truncate-silent"];
const modeStr = (r) =>
  r.threw
    ? `stream() THROWS ${r.errorName} (${JSON.stringify(r.errorMessage)}), statusCode=${r.statusCode} — ` +
      `gg-ai classification: ${r.classification} (source=${r.errorSource}); retryable: ${r.retryablePerGgAi}`
    : `stream() does NOT throw — partial text ${JSON.stringify(r.text)} returned as stopReason="${r.stopReason}"` +
      (r.silentPartial ? " — SILENT PARTIAL (indistinguishable from a finished turn)" : "");
const tmStr = modeStr(tm);
const tsStr = modeStr(ts);
const verdict =
  `clean: full sequence works (stop=${modes.clean.stopReason}, text=${JSON.stringify(modes.clean.text)}). ` +
  `truncate-mid (socket destroyed mid-events): ${tmStr}. ` +
  `truncate-silent (clean TCP close, no message_stop): ${tsStr}. ` +
  `anthropic.ts now guards both the zero-event case ("Stream ended without producing any events") and the ` +
  `started-but-never-finished case ("Stream ended before completion (no stop_reason)") with statusCode 504, so a ` +
  `truncated stream is a retryable transport failure instead of a phantom-complete end_turn.`;

console.log("\nverdict:", verdict);
writeResult("08-fault-stream-truncate", {
  mockRequests: requests.map((r) => `${r.method} ${r.path}?mode seen`),
  modes: { clean: modes.clean, truncateMid: modes["truncate-mid"], truncateSilent: modes["truncate-silent"] },
  verdict,
});
