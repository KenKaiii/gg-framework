import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import {
  agentToolToVoiceTool,
  executeVoiceToolCall,
  voiceToolToRealtimeFunctionTool,
} from "./tools.js";
import type { VoiceTool } from "./types.js";

describe("voice tools", () => {
  it("converts an AgentTool to a realtime function tool", () => {
    const agentTool: AgentTool<z.ZodObject<{ name: z.ZodString }>> = {
      name: "greet",
      description: "Greet a person",
      parameters: z.object({ name: z.string() }),
      execute: ({ name }) => `hello ${name}`,
    };

    const voiceTool = agentToolToVoiceTool(agentTool);
    const realtimeTool = voiceToolToRealtimeFunctionTool(voiceTool);

    expect(realtimeTool).toMatchObject({
      type: "function",
      name: "greet",
      description: "Greet a person",
      parameters: {
        type: "object",
      },
    });
  });

  it("executes a validated agent tool call", async () => {
    const agentTool: AgentTool<z.ZodObject<{ count: z.ZodNumber }>> = {
      name: "double",
      description: "Double a number",
      parameters: z.object({ count: z.number() }),
      execute: ({ count }) => String(count * 2),
    };

    const result = await executeVoiceToolCall({
      tools: [agentToolToVoiceTool(agentTool)],
      call: { id: "call_1", name: "double", args: { count: 3 } },
    });

    expect(result).toEqual({
      toolCallId: "call_1",
      name: "double",
      content: "6",
    });
  });

  it("emits an error result for missing tools", async () => {
    const result = await executeVoiceToolCall({
      tools: [],
      call: { id: "call_1", name: "missing", args: {} },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ type: "tool_not_found" });
  });

  it("denies confirmable tools when no confirmation resolver is provided", async () => {
    const tool: VoiceTool = {
      name: "delete_file",
      description: "Delete a file",
      parameters: { type: "object", properties: {} },
      confirmation: "always",
      execute: () => "deleted",
    };

    const result = await executeVoiceToolCall({
      tools: [tool],
      call: { id: "call_1", name: "delete_file", args: {} },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ type: "tool_confirmation_denied" });
  });
});
