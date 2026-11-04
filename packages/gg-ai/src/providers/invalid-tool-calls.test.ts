import { describe, expect, it } from "vitest";
import type { ContentPart, Message } from "../types.js";
import {
  dropInvalidToolCalls,
  isValidToolCallName,
  toAnthropicMessages,
  toOpenAIMessages,
  toolCallNameRuleFor,
  TOOL_CALL_NAME_RULES,
  type ToolCallNameRule,
} from "./transform.js";

const NAME_64 = "a".repeat(64);
const NAME_65 = "a".repeat(65);
const NAME_128 = "a".repeat(128);
const NAME_129 = "a".repeat(129);

// [name, anthropic, openai-chat, openai-responses, gemini, generic]
const NAME_TABLE: [string, boolean, boolean, boolean, boolean, boolean][] = [
  ["read", true, true, true, true, true],
  ["mcp__server__tool-name", true, true, true, true, true],
  ["", false, false, false, false, false],
  ["   ", false, false, false, false, false],
  ['bash {"command":"ls"}', false, false, false, false, false],
  ["read\n", false, false, false, false, false],
  ["read\u0000", false, false, false, false, false],
  [NAME_64, true, true, true, true, true],
  [NAME_65, true, false, true, true, true],
  [NAME_128, true, false, true, true, true],
  [NAME_129, false, false, false, false, false],
  ["ns.tool", false, false, false, true, true],
  ["ns:tool", false, false, false, true, true],
  ["1tool", true, true, true, false, true],
  ["-tool", true, true, true, false, true],
  ["tool()", false, false, false, false, true],
  ["outil_é", false, false, false, false, true],
];

describe("isValidToolCallName", () => {
  const ids = ["anthropic", "openai-chat", "openai-responses", "gemini", "generic"] as const;
  it.each(NAME_TABLE)("%j", (name, ...expected) => {
    ids.forEach((id, i) => {
      expect([id, isValidToolCallName(name, TOOL_CALL_NAME_RULES[id])]).toEqual([id, expected[i]]);
    });
  });

  it("rejects non-string names", () => {
    expect(isValidToolCallName(undefined, TOOL_CALL_NAME_RULES.anthropic)).toBe(false);
    expect(isValidToolCallName(42, TOOL_CALL_NAME_RULES.generic)).toBe(false);
  });
});

describe("toolCallNameRuleFor", () => {
  it.each<[string, { accountId?: string; baseUrl?: string } | undefined, ToolCallNameRule["id"]]>([
    ["anthropic", undefined, "anthropic"],
    ["anthropic", { baseUrl: "https://proxy.example.com" }, "anthropic"],
    ["openai", undefined, "openai-chat"],
    ["openai", { baseUrl: "https://api.openai.com/v1" }, "openai-chat"],
    ["openai", { accountId: "acct" }, "openai-responses"],
    ["openai", { baseUrl: "http://localhost:1234/v1" }, "generic"],
    ["gemini", undefined, "gemini"],
    ["glm", undefined, "generic"],
    ["moonshot", undefined, "generic"],
    ["minimax", undefined, "generic"],
    ["openrouter", undefined, "generic"],
    ["deepseek", undefined, "generic"],
    ["xai", undefined, "generic"],
  ])("%s %j → %s", (provider, opts, id) => {
    expect(toolCallNameRuleFor(provider, opts).id).toBe(id);
  });
});

const BAD = 'bash {"command":"ls"}';

function asst(...content: ContentPart[]): Message {
  return { role: "assistant", content };
}
function call(id: string, name: string): ContentPart {
  return { type: "tool_call", id, name, args: {} };
}
function results(...ids: string[]): Message {
  return {
    role: "tool",
    content: ids.map((id) => ({
      type: "tool_result" as const,
      toolCallId: id,
      content: `r-${id}`,
    })),
  };
}
const user = (text: string): Message => ({ role: "user", content: text });

describe("dropInvalidToolCalls", () => {
  it("returns the same array when nothing is malformed", () => {
    const msgs = [user("hi"), asst(call("t1", "read")), results("t1")];
    expect(dropInvalidToolCalls(msgs, TOOL_CALL_NAME_RULES.anthropic)).toBe(msgs);
  });

  it("drops the bad call and its result but keeps the valid sibling and text", () => {
    const msgs = [
      user("go"),
      asst({ type: "text", text: "let me look" }, call("t1", BAD), call("t2", "read")),
      results("t1", "t2"),
      user("next"),
    ];
    expect(dropInvalidToolCalls(msgs, TOOL_CALL_NAME_RULES.anthropic)).toEqual([
      user("go"),
      asst({ type: "text", text: "let me look" }, call("t2", "read")),
      results("t2"),
      user("next"),
    ]);
  });

  it("removes an assistant turn left empty (thinking alone is not a turn) and its tool message", () => {
    const msgs = [
      user("go"),
      asst({ type: "thinking", text: "hmm", signature: "sig" }, call("t1", "")),
      results("t1"),
      user("try again"),
    ];
    expect(dropInvalidToolCalls(msgs, TOOL_CALL_NAME_RULES.anthropic)).toEqual([
      user("go"),
      user("try again"),
    ]);
  });

  it("removes a pruned assistant turn that would otherwise end the request as a prefill", () => {
    const msgs = [user("go"), asst({ type: "text", text: "calling" }, call("t1", BAD))];
    expect(dropInvalidToolCalls(msgs, TOOL_CALL_NAME_RULES.anthropic)).toEqual([user("go")]);
  });

  it("keeps an untouched trailing assistant turn as-is", () => {
    const msgs = [
      user("go"),
      asst(call("t1", BAD)),
      results("t1"),
      user("again"),
      asst({ type: "text", text: "prefill" }),
    ];
    const out = dropInvalidToolCalls(msgs, TOOL_CALL_NAME_RULES.anthropic);
    expect(out).toEqual([user("go"), user("again"), asst({ type: "text", text: "prefill" })]);
  });

  it("drops calls with a blank id", () => {
    const msgs = [user("go"), asst(call("", "read"), call("t2", "read")), results("", "t2")];
    expect(dropInvalidToolCalls(msgs, TOOL_CALL_NAME_RULES.generic)).toEqual([
      user("go"),
      asst(call("t2", "read")),
      results("t2"),
    ]);
  });

  it("pairs results per turn so a reused id never consumes another turn's result", () => {
    const msgs = [
      user("go"),
      asst(call("dup", BAD)),
      results("dup"),
      asst(call("dup", "read")),
      results("dup"),
    ];
    expect(dropInvalidToolCalls(msgs, TOOL_CALL_NAME_RULES.anthropic)).toEqual([
      user("go"),
      asst(call("dup", "read")),
      results("dup"),
    ]);
  });

  it("removes a Codex reasoning item orphaned by the drop", () => {
    const reasoning: ContentPart = { type: "raw", data: { type: "reasoning", id: "rs_1" } };
    const msgs = [
      user("go"),
      asst({ type: "text", text: "a" }, reasoning, call("t1", BAD)),
      results("t1"),
      user("next"),
    ];
    expect(dropInvalidToolCalls(msgs, TOOL_CALL_NAME_RULES["openai-responses"])).toEqual([
      user("go"),
      asst({ type: "text", text: "a" }),
      user("next"),
    ]);
  });

  it.each<[ToolCallNameRule["id"], string, boolean]>([
    ["anthropic", NAME_65, true],
    ["openai-chat", NAME_65, false],
    ["openai-responses", NAME_129, false],
    ["gemini", "1tool", false],
    ["gemini", "ns.tool", true],
    ["generic", "ns.tool", true],
    ["generic", "", false],
  ])("%s keeps %j: %s", (id, name, kept) => {
    const msgs = [user("go"), asst(call("t1", name)), results("t1"), user("next")];
    const out = dropInvalidToolCalls(msgs, TOOL_CALL_NAME_RULES[id]);
    expect(out.length).toBe(kept ? 4 : 2);
  });

  it("produces a valid Anthropic payload (paired tool_use/tool_result, no empty assistant)", () => {
    const msgs = [
      user("go"),
      asst(call("t1", BAD)),
      results("t1"),
      asst({ type: "text", text: "ok" }, call("t2", "read"), call("t3", "")),
      results("t2", "t3"),
    ];
    const { messages } = toAnthropicMessages(
      dropInvalidToolCalls(msgs, TOOL_CALL_NAME_RULES.anthropic),
    );
    const uses = new Set<string>();
    const res = new Set<string>();
    for (const m of messages) {
      const blocks = Array.isArray(m.content) ? m.content : [];
      if (m.role === "assistant") expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) {
        if (b.type === "tool_use") {
          expect(b.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
          uses.add(b.id);
        }
        if (b.type === "tool_result") res.add(b.tool_use_id);
      }
    }
    expect([...uses]).toEqual(["t2"]);
    expect([...res]).toEqual(["t2"]);
  });

  it("produces a valid OpenAI chat payload (every tool message answers a kept call)", () => {
    const msgs = [user("go"), asst(call("t1", NAME_65), call("t2", "read")), results("t1", "t2")];
    const out = toOpenAIMessages(dropInvalidToolCalls(msgs, TOOL_CALL_NAME_RULES["openai-chat"]));
    const callIds = out.flatMap((m) =>
      m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : [],
    );
    const toolIds = out.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
    expect(callIds).toEqual(["t2"]);
    expect(toolIds).toEqual(["t2"]);
  });
});
