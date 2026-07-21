// 10-empty-parts — baseline for item #20 (omit empty prompt text parts).
// Question: does gg-ai ever serialize empty text parts into the outbound request?
// Local mock capture server (anthropic mode); apiKey "bench-mock".
// Run from repo root:  node bench/baseline/10-empty-parts.mjs
import http from "node:http";
import { stream, SONNET, writeResult, table } from "./lib.mjs";

// ── Capture mock (Anthropic wire) ────────────────────────────
const captured = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    captured.push(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const sse = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_bench", type: "message", role: "assistant", model: SONNET,
        content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 },
      },
    });
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
    sse("content_block_stop", { type: "content_block_stop", index: 0 });
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    sse("message_stop", { type: "message_stop" });
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function send(messages) {
  const s = stream({ provider: "anthropic", model: SONNET, apiKey: "bench-mock", baseUrl, messages, maxTokens: 16 });
  s.then(() => {}, () => {});
  for await (const ev of s) void ev;
  return captured[captured.length - 1];
}

// ── Cases ────────────────────────────────────────────────────
// Each case: messages in, then inspect the wire payload for empty/whitespace
// text parts and dropped messages.
const cases = [];

function analyze(name, messages, wire) {
  const empties = [];
  const whitespaces = [];
  for (const [i, m] of (wire.messages ?? []).entries()) {
    const parts = Array.isArray(m.content) ? m.content : [m.content];
    for (const p of parts) {
      if (typeof p === "string") {
        if (p === "") empties.push(`messages[${i}](${m.role}) string content ""`);
      } else if (p && p.type === "text" && typeof p.text === "string") {
        if (p.text === "") empties.push(`messages[${i}](${m.role}) {type:"text",text:""}`);
        else if (p.text.trim() === "") whitespaces.push(`messages[${i}](${m.role}) whitespace-only text ${JSON.stringify(p.text)}`);
      }
    }
  }
  const c = {
    name,
    rolesIn: messages.map((m) => m.role).join(","),
    rolesOnWire: (wire.messages ?? []).map((m) => m.role).join(","),
    messagesDropped: messages.length - (wire.messages ?? []).length,
    emptyPartsOnWire: empties,
    whitespacePartsOnWire: whitespaces,
    snippet: (wire.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
  };
  cases.push(c);
  return c;
}

// A: user message with content "" (string)
analyze("A: user string ''", [{ role: "user", content: "" }], await send([{ role: "user", content: "" }]));

// B: user message with one empty text block
analyze(
  "B: user [{text:''}]",
  [{ role: "user", content: [{ type: "text", text: "" }] }],
  await send([{ role: "user", content: [{ type: "text", text: "" }] }]),
);

// C: user message with whitespace-only text block
analyze(
  "C: user [{text:'  \\n '}]",
  [{ role: "user", content: [{ type: "text", text: "  \n " }] }],
  await send([{ role: "user", content: [{ type: "text", text: "  \n " }] }]),
);

// D: settled assistant message with content "" (string), between users
analyze(
  "D: settled assistant string ''",
  [
    { role: "user", content: "hi" },
    { role: "assistant", content: "" },
    { role: "user", content: "next" },
  ],
  await send([
    { role: "user", content: "hi" },
    { role: "assistant", content: "" },
    { role: "user", content: "next" },
  ]),
);

// E: settled assistant message whose ONLY part is an empty text block
analyze(
  "E: settled assistant [{text:''}] only",
  [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "" }] },
    { role: "user", content: "next" },
  ],
  await send([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "" }] },
    { role: "user", content: "next" },
  ]),
);

// F: settled assistant with empty text + real text
analyze(
  "F: settled assistant [{text:''},{text:'real'}]",
  [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "real" }] },
    { role: "user", content: "next" },
  ],
  await send([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "real" }] },
    { role: "user", content: "next" },
  ]),
);

// G: settled assistant with whitespace-only text block
analyze(
  "G: settled assistant [{text:' '}]",
  [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: " " }] },
    { role: "user", content: "next" },
  ],
  await send([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: " " }] },
    { role: "user", content: "next" },
  ]),
);

// H: ACTIVE-trajectory assistant (last message, after last user) with an empty
// text block BEFORE a signed thinking block — position-sensitive keep.
analyze(
  "H: active assistant [{text:''},{thinking signed}]",
  [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "thinking", text: "hmm", signature: "sig123" },
      ],
    },
  ],
  await send([
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "thinking", text: "hmm", signature: "sig123" },
      ],
    },
  ]),
);

server.close();

// ── Report ───────────────────────────────────────────────────
console.log("== 10-empty-parts ==");
table(
  cases.map((c) => [
    c.name,
    c.rolesOnWire,
    c.messagesDropped,
    c.emptyPartsOnWire.length ? c.emptyPartsOnWire.join("; ") : "-",
    c.whitespacePartsOnWire.length ? "yes" : "-",
  ]),
  ["case", "wire roles", "dropped", "empty parts on wire", "whitespace on wire"],
);

const anyEmpty = cases.some((c) => c.emptyPartsOnWire.length > 0);
const anyWhitespace = cases.some((c) => c.whitespacePartsOnWire.length > 0);
const offenders = cases.filter((c) => c.emptyPartsOnWire.length > 0).map((c) => c.name);
const summary =
  `emptyPartsOnWire=${anyEmpty}, whitespacePartsOnWire=${anyWhitespace}. ` +
  `Cases still emitting an empty text part on the wire: ${offenders.length ? offenders.join(" | ") : "none"}. ` +
  "POST Fix E (transform.ts toAnthropicMessages): user string '' (A) and settled assistant string '' (D) now " +
  "drop the whole degenerate turn; empty text parts are filtered out of user content arrays (B), while non-text " +
  "parts (images) and whitespace-only text (C, G — non-empty, API-accepted) are left intact. The ONLY remaining " +
  "empty text part is case H: in the ACTIVE trajectory an empty text block preceding a signed thinking block is " +
  "deliberately kept for positional integrity (dropping it shifts the signed thinking block and trips 'thinking " +
  "blocks cannot be modified') — this is by design and covered by a dedicated transform.test.ts case. A/B/D " +
  "(the live 400 failure modes) are fixed.";

console.log("\nsummary:", summary);
writeResult("10-empty-parts", {
  cases,
  emptyPartsOnWire: anyEmpty,
  whitespacePartsOnWire: anyWhitespace,
  snippets: cases.map((c) => ({ name: c.name, snippet: c.snippet })),
  summary,
});
