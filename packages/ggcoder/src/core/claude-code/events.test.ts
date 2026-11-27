import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SdkMessageMapper } from "./events.js";

const stream = (event: Record<string, unknown>): SDKMessage =>
  ({ type: "stream_event", event, parent_tool_use_id: null }) as unknown as SDKMessage;

describe("SdkMessageMapper tool-call deltas", () => {
  it("names the streaming call and carries its argument chunk", () => {
    const mapper = new SdkMessageMapper({ messages: [], takeResult: () => undefined });
    mapper.handle(stream({ type: "message_start", message: {} }));
    mapper.handle(
      stream({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "mcp__gg__write", input: {} },
      }),
    );
    const events = mapper.handle(
      stream({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"a.html"' },
      }),
    );
    expect(events).toEqual([
      {
        type: "toolcall_delta",
        chars: 21,
        toolCallId: "toolu_1",
        name: "write",
        argsDelta: '{"file_path":"a.html"',
      },
    ]);
    mapper.handle(stream({ type: "content_block_stop", index: 1 }));
    const after = mapper.handle(
      stream({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "x" },
      }),
    );
    expect(after).toEqual([{ type: "toolcall_delta", chars: 1, argsDelta: "x" }]);
  });
});
