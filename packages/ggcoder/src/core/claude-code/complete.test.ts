import type {
  Options as SdkOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeCodeSearchHits } from "../../tools/side-web-search.js";
import { claudeCodeComplete, resolveClaudeCodeProcess } from "./complete.js";

function fakeQuery(replies: SDKMessage[]) {
  const seen = {
    options: undefined as SdkOptions | undefined,
    inputs: [] as SDKUserMessage[],
    closed: 0,
  };
  const query = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: SdkOptions;
  }) => {
    seen.options = options;
    const generator = (async function* () {
      for await (const input of prompt) seen.inputs.push(input);
      yield* replies;
    })();
    return Object.assign(generator, { close: () => seen.closed++ }) as unknown as Query;
  };
  return { query, seen };
}

const proc = { executable: "/bin/claude", cwd: "/tmp/proj", env: {} };
const assistant = (id: string, content: unknown[], model = "claude-haiku-5-5"): SDKMessage =>
  ({ type: "assistant", parent_tool_use_id: null, message: { id, model, content } }) as SDKMessage;
const result = (extra: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 9 },
    ...extra,
  }) as SDKMessage;

describe("claudeCodeComplete", () => {
  it("runs one tool-free turn with our system prompt and returns the reply", async () => {
    const { query, seen } = fakeQuery([
      assistant("m1", [{ type: "thinking", thinking: "hmm", signature: "sig" }]),
      assistant("m1", [{ type: "text", text: "Paris" }]),
      result(),
    ]);
    const reply = await claudeCodeComplete({
      ...proc,
      query,
      model: "claude-sonnet-5",
      thinking: "high",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
        { role: "user", content: "Capital of France?" },
      ],
    });
    expect(reply).toEqual({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "hmm", signature: "sig" },
          { type: "text", text: "Paris" },
        ],
      },
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 4, cacheRead: 9 },
      toolOutputs: [],
    });
    expect(seen.options).toMatchObject({
      systemPrompt: { type: "custom", prompt: "Be terse." },
      tools: [],
      settingSources: [],
      mcpServers: {},
      persistSession: false,
      maxTurns: 1,
      model: "claude-sonnet-5",
      effort: "high",
      thinking: { type: "adaptive" },
    });
    const content = seen.inputs[0]!.message.content as { text: string }[];
    expect(content).toHaveLength(2);
    expect(content[0]!.text).toContain("User: Earlier question");
    expect(content[0]!.text).toContain("Assistant: Earlier answer");
    expect(content[1]).toEqual({ type: "text", text: "Capital of France?" });
    expect(seen.closed).toBe(1);
  });

  it("collects built-in tool outputs and only allows the named built-ins", async () => {
    const output = { results: [{ content: [{ title: "Node", url: "https://nodejs.org" }] }] };
    const { query, seen } = fakeQuery([
      {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [] },
        tool_use_result: output,
      } as SDKMessage,
      assistant("m2", [{ type: "text", text: "Node 26" }]),
      result(),
    ]);
    const reply = await claudeCodeComplete({
      ...proc,
      query,
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "search" }],
      builtinTools: ["WebSearch"],
      maxTurns: 2,
    });
    expect(reply.toolOutputs).toEqual([output]);
    expect(claudeCodeSearchHits(reply.toolOutputs)).toEqual([
      { title: "Node", url: "https://nodejs.org" },
    ]);
    expect(seen.options).toMatchObject({
      tools: ["WebSearch"],
      maxTurns: 2,
      thinking: { type: "disabled" },
    });
    // allowedTools would skip canUseTool (SDK warning CLAUDE_SDK_CAN_USE_TOOL_SHADOWED).
    expect(seen.options!.allowedTools).toBeUndefined();
    const sig = { signal: new AbortController().signal } as Parameters<
      NonNullable<SdkOptions["canUseTool"]>
    >[2];
    expect((await seen.options!.canUseTool!("WebSearch", {}, sig))?.behavior).toBe("allow");
    expect((await seen.options!.canUseTool!("Bash", {}, sig))?.behavior).toBe("deny");
  });

  it("throws Claude Code's error instead of returning an empty reply", async () => {
    const { query } = fakeQuery([
      assistant("x", [{ type: "text", text: "API Error: 401 invalid credentials" }], "<synthetic>"),
      result({ is_error: true, result: "" }),
    ]);
    await expect(
      claudeCodeComplete({
        ...proc,
        query,
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("API Error: 401");
  });
});

describe("resolveClaudeCodeProcess", () => {
  it("is null off the subscription route", async () => {
    const signedIn = { hasClaudeCodeLogin: async () => true };
    const signedOut = { hasClaudeCodeLogin: async () => false };
    expect(await resolveClaudeCodeProcess(signedIn, "openai", "/tmp")).toBeNull();
    expect(await resolveClaudeCodeProcess(signedOut, "anthropic", "/tmp")).toBeNull();
  });
});
