import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Message, Tool } from "../types.js";
import { streamOpenAICodex } from "./openai-codex.js";
import {
  planDeferredTools,
  toAnthropicMessages,
  toAnthropicTools,
  usesDeferredToolLoading,
} from "./transform.js";

const tool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  parameters: z.object({ q: z.string() }),
});
const read = tool("read");
const search = tool("tool_search");
const steroids = tool("steroids");
const debug = tool("debug");
const catalog = [steroids, debug];

const user: Message = { role: "user", content: "find code" };
const call: Message = {
  role: "assistant",
  content: [{ type: "tool_call", id: "call_1", name: "tool_search", args: { query: "code" } }],
};
const loaded: Message = {
  role: "tool",
  content: [
    {
      type: "tool_result",
      toolCallId: "call_1",
      content: "1 tool(s) now available",
      loadedTools: ["steroids"],
    },
  ],
};

/** Anthropic tools block exactly as anthropic.ts builds it. */
function anthropicTools(live: Tool[], messages: Message[]): string {
  const plan = planDeferredTools(live, catalog, messages);
  return JSON.stringify(
    toAnthropicTools(plan?.live ?? live, {
      cacheControl: { type: "ephemeral" },
      deferred: plan?.deferred,
    }),
  );
}

describe("deferred tool loading", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the Anthropic tools block byte-identical across a promotion", () => {
    const before = anthropicTools([read, search], [user]);
    // The session appends the promoted tool to its live list, as before.
    const after = anthropicTools([read, search, steroids], [user, call, loaded]);
    expect(after).toBe(before);
    const parsed = JSON.parse(before) as Array<Record<string, unknown>>;
    expect(parsed.map((t) => [t.name, t.defer_loading ?? false])).toEqual([
      ["read", false],
      ["tool_search", false],
      ["steroids", true],
      ["debug", true],
    ]);
    // cache_control stays on the last live tool, never on a deferred one.
    expect(parsed[1]?.cache_control).toBeDefined();
    expect(parsed[2]?.cache_control).toBeUndefined();
  });

  it("loads the tool through a tool_reference and keeps the result text", () => {
    const plan = planDeferredTools([read, search, steroids], catalog, [user, call, loaded]);
    const { messages } = toAnthropicMessages([user, call, loaded], undefined, {
      toolReferences: plan?.loaded,
    });
    expect(messages.at(-1)?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: [{ type: "tool_reference", tool_name: "steroids" }],
        is_error: undefined,
      },
      { type: "text", text: "Result of tool call call_1:\n1 tool(s) now available" },
    ]);
  });

  it("adds a Codex tool_search pair without changing tools or the earlier prefix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const send = async (tools: Tool[], messages: Message[]) => {
      for await (const _ of streamOpenAICodex({
        provider: "openai",
        model: "gpt-6-luna",
        messages,
        tools,
        deferredTools: catalog,
        apiKey: "t",
        accountId: "a",
      })) {
        /* consume */
      }
    };
    await send([read, search], [user, call]);
    await send([read, search, steroids], [user, call, loaded]);
    const bodies = vi
      .mocked(fetch)
      .mock.calls.map((c) => JSON.parse(c[1]?.body as string) as Record<string, unknown[]>);
    const [first, second] = bodies as [Record<string, unknown[]>, Record<string, unknown[]>];
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(second.input.slice(0, first.input.length)).toEqual(first.input);
    expect(second.input.slice(-2)).toMatchObject([
      { type: "tool_search_call", call_id: "gg_tool_load_1", execution: "client" },
      {
        type: "tool_search_output",
        call_id: "gg_tool_load_1",
        tools: [{ type: "function", name: "steroids", defer_loading: true }],
      },
    ]);
  });

  it("leaves transports without deferred loading on the old append path", () => {
    expect(usesDeferredToolLoading({ provider: "anthropic", model: "claude-sonnet-5-5" })).toBe(
      true,
    );
    expect(
      usesDeferredToolLoading({ provider: "openai", model: "gpt-6-luna", accountId: "a" }),
    ).toBe(true);
    for (const options of [
      { provider: "openai", model: "gpt-6-luna" }, // chat completions (API key)
      { provider: "openai", model: "gpt-5.2", accountId: "a" }, // pre-5.4 Codex
      { provider: "anthropic", model: "claude-opus-4-1" },
      { provider: "minimax", model: "MiniMax-M3", baseUrl: "https://api.minimax.io/anthropic" },
      { provider: "gemini", model: "gemini-3-flash" },
      { provider: "xai", model: "grok-4.7" },
      { provider: "glm", model: "glm-5.3" },
      { provider: "deepseek", model: "deepseek-v4-pro" },
    ]) {
      expect(usesDeferredToolLoading(options)).toBe(false);
    }
    // No catalog → no plan → providers send `tools` exactly as before.
    expect(planDeferredTools([read], undefined, [user])).toBeUndefined();
  });
});
