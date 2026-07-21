// 09-provider-id-replay — baseline for item #5 (tool-call ID normalization on
// provider switch). Question: replaying an Anthropic-format tool-call history
// to the OpenAI provider (or vice versa) — do tool_call ids survive/pair?
// Local mock capture servers only; apiKey "bench-mock".
// Run from repo root:  node bench/baseline/09-provider-id-replay.mjs
import http from "node:http";
import { stream, SONNET, writeResult, table } from "./lib.mjs";

// ── Capture mock: speaks both wire protocols ─────────────────
const captured = []; // { endpoint, body }
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
    if (req.url.endsWith("/chat/completions")) {
      captured.push({ endpoint: "openai", body });
      // Minimal streaming chat-completions response (one assistant text msg).
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish, usage) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-bench",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "ack" }, null));
      res.write(chunk({}, "stop"));
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-bench",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [],
          usage: { prompt_tokens: 60, completion_tokens: 1, total_tokens: 61 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    // Anthropic /v1/messages
    captured.push({ endpoint: "anthropic", body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const sse = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_bench",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 60, output_tokens: 1 },
      },
    });
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ack" } });
    sse("content_block_stop", { type: "content_block_stop", index: 0 });
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    sse("message_stop", { type: "message_stop" });
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ── Histories ────────────────────────────────────────────────
const TOOLU_ID = "toolu_01ABCdefGHIjkl";
const anthropicHistory = [
  { role: "user", content: "Read config.ts" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Reading it now." },
      { type: "tool_call", id: TOOLU_ID, name: "read", args: { path: "config.ts" } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool_result", toolCallId: TOOLU_ID, content: "export const x = 1;" }],
  },
  { role: "user", content: "What does it define?" },
];

const CALL_ID = "call_9Zx8y7w6v5";
const openaiHistory = [
  { role: "user", content: "Read config.ts" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Reading it now." },
      { type: "tool_call", id: CALL_ID, name: "read", args: { path: "config.ts" } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool_result", toolCallId: CALL_ID, content: "export const x = 1;" }],
  },
  { role: "user", content: "What does it define?" },
];

// Codex-style composite id (callId|itemId) — illegal chars for Anthropic.
const COMPOSITE_ID = "call_abc123|fc_item_456";
const compositeHistory = [
  { role: "user", content: "Read config.ts" },
  {
    role: "assistant",
    content: [{ type: "tool_call", id: COMPOSITE_ID, name: "read", args: { path: "config.ts" } }],
  },
  {
    role: "tool",
    content: [{ type: "tool_result", toolCallId: COMPOSITE_ID, content: "export const x = 1;" }],
  },
  { role: "user", content: "and?" },
];

async function send(provider, model, baseUrl, messages) {
  const s = stream({ provider, model, apiKey: "bench-mock", baseUrl, messages, maxTokens: 16 });
  s.then(() => {}, () => {});
  for await (const ev of s) void ev;
  return s;
}

// ── Case 1: Anthropic history → OpenAI provider ─────────────
await send("openai", "gpt-5.5", `http://127.0.0.1:${port}/v1`, anthropicHistory);
const oaiBody = captured[captured.length - 1].body;
const oaiAssistant = oaiBody.messages.find((m) => m.role === "assistant");
const oaiTool = oaiBody.messages.find((m) => m.role === "tool");
const a2o = {
  sentId: TOOLU_ID,
  wireToolCallId: oaiAssistant?.tool_calls?.[0]?.id ?? null,
  wireToolResultId: oaiTool?.tool_call_id ?? null,
  pairingConsistent: (oaiAssistant?.tool_calls?.[0]?.id ?? null) === (oaiTool?.tool_call_id ?? null),
  behavior: null,
  snippet: {
    assistant: { role: "assistant", content: oaiAssistant?.content, tool_calls: oaiAssistant?.tool_calls },
    tool: oaiTool,
  },
};
a2o.behavior =
  a2o.wireToolCallId === TOOLU_ID
    ? "pass-through (verbatim)"
    : a2o.wireToolCallId
      ? `normalized: toolu_* → ${JSON.stringify(a2o.wireToolCallId)} (transform.ts remapToolCallId: "call_" + id.slice(5) — note slice(5) keeps the "_" from "toolu_", producing a double underscore)`
      : "DROPPED";

// ── Case 2: OpenAI history → Anthropic provider ─────────────
await send("anthropic", SONNET, `http://127.0.0.1:${port}`, openaiHistory);
const antBody = captured[captured.length - 1].body;
const antAssistant = antBody.messages.find((m) => m.role === "assistant");
const antToolUse = antAssistant?.content?.find?.((b) => b.type === "tool_use");
const antUserToolResult = antBody.messages
  .filter((m) => m.role === "user")
  .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .find((b) => b.type === "tool_result");
const o2a = {
  sentId: CALL_ID,
  wireToolUseId: antToolUse?.id ?? null,
  wireToolResultId: antUserToolResult?.tool_use_id ?? null,
  pairingConsistent: (antToolUse?.id ?? null) === (antUserToolResult?.tool_use_id ?? null),
  behavior: null,
  snippet: {
    assistantContent: antAssistant?.content,
    toolResult: antUserToolResult,
  },
};
o2a.behavior =
  o2a.wireToolUseId === CALL_ID
    ? "pass-through (verbatim — call_* matches Anthropic's ^[a-zA-Z0-9_-]+$ so remapAnthropicToolCallId returns it unchanged)"
    : o2a.wireToolUseId
      ? `normalized: ${JSON.stringify(o2a.wireToolUseId)}`
      : "DROPPED";

// ── Case 3: composite (Codex-style) id → Anthropic ──────────
await send("anthropic", SONNET, `http://127.0.0.1:${port}`, compositeHistory);
const compBody = captured[captured.length - 1].body;
const compToolUse = compBody.messages
  .find((m) => m.role === "assistant")
  ?.content?.find?.((b) => b.type === "tool_use");
const compToolResult = compBody.messages
  .filter((m) => m.role === "user")
  .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .find((b) => b.type === "tool_result");
const composite = {
  sentId: COMPOSITE_ID,
  wireToolUseId: compToolUse?.id ?? null,
  wireToolResultId: compToolResult?.tool_use_id ?? null,
  pairingConsistent: (compToolUse?.id ?? null) === (compToolResult?.tool_use_id ?? null),
  behavior: "sanitized: [^a-zA-Z0-9_-] → '_' (memoized via idMap so tool_use and tool_result stay paired)",
};
server.close();

console.log("== 09-provider-id-replay ==");
table(
  [
    ["anthropic→openai", a2o.sentId, a2o.wireToolCallId, a2o.wireToolResultId, a2o.pairingConsistent],
    ["openai→anthropic", o2a.sentId, o2a.wireToolUseId, o2a.wireToolResultId, o2a.pairingConsistent],
    ["composite→anthropic", composite.sentId, composite.wireToolUseId, composite.wireToolResultId, composite.pairingConsistent],
  ],
  ["direction", "sent id", "wire call id", "wire result id", "paired"],
);
console.log("\nanthropic→openai:", a2o.behavior);
console.log("openai→anthropic:", o2a.behavior);
console.log("composite→anthropic:", composite.behavior);

const verdict =
  "The conversion layer NORMALIZES rather than passing through, and pairing is preserved in both directions. " +
  `Anthropic→OpenAI (transform.ts remapToolCallId): toolu_* ids become "call_" + id.slice(5) — ${TOOLU_ID} → ${a2o.wireToolCallId} ` +
  "(slice(5), not slice(6), retains the underscore from 'toolu_', so every remapped id carries a DOUBLE underscore 'call__…'; " +
  "valid for OpenAI but lossy — the reverse mapping is not identity). Non-toolu ids pass through verbatim. " +
  `OpenAI→Anthropic (transform.ts remapAnthropicToolCallId): ids matching ^[a-zA-Z0-9_-]+$ pass through verbatim (${CALL_ID} survived); ` +
  `ids with illegal chars (Codex composite 'callId|itemId') are char-sanitized (${COMPOSITE_ID} → ${composite.wireToolUseId}), ` +
  "memoized in an idMap so the assistant tool_use and the tool_result stay paired. " +
  "Nothing is regenerated with fresh randomness and nothing is dropped; collisions after sanitization (two ids differing only in illegal chars) would silently merge.";

console.log("\nverdict:", verdict);
writeResult("09-provider-id-replay", {
  anthropicToOpenai: a2o,
  openaiToAnthropic: o2a,
  compositeToAnthropic: composite,
  verdict,
});
