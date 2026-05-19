import type { AgentTool, ToolContext, ToolExecuteResult } from "@kenkaiiii/gg-agent";
import type { Tool } from "@kenkaiiii/gg-ai";
import { z } from "zod";
import type {
  JsonObject,
  RealtimeFunctionToolDefinition,
  ToolConfirmationDecision,
  VoiceTool,
  VoiceToolCall,
  VoiceToolContext,
  VoiceToolExecutionError,
  VoiceToolExecutionResult,
  VoiceToolResult,
} from "./types.js";

type ZodParseResult = { success: true; data: unknown } | { success: false; error: z.ZodError };

export type VoiceToolSource = VoiceTool | AgentTool | Tool;

export interface ExecuteVoiceToolCallOptions {
  readonly tools: readonly VoiceTool[];
  readonly call: VoiceToolCall;
  readonly signal?: AbortSignal;
  readonly confirmation?: VoiceToolContext["confirmation"];
  readonly onUpdate?: VoiceToolContext["onUpdate"];
}

export function ggAiToolToRealtimeFunctionTool(tool: Tool): RealtimeFunctionToolDefinition {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.rawInputSchema ?? zodToJsonSchemaObject(tool.parameters),
  };
}

export function voiceToolToRealtimeFunctionTool(tool: VoiceTool): RealtimeFunctionToolDefinition {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

export function ggAiToolToVoiceTool(tool: Tool): VoiceTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.rawInputSchema ?? zodToJsonSchemaObject(tool.parameters),
  };
}

export function agentToolToVoiceTool<T extends z.ZodType>(tool: AgentTool<T>): VoiceTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.rawInputSchema ?? zodToJsonSchemaObject(tool.parameters),
    async execute(args, context): Promise<VoiceToolExecutionResult> {
      const parsed = tool.parameters.safeParse(args) as ZodParseResult;
      if (!parsed.success) {
        return {
          error: "Invalid tool arguments",
          issues: parsed.error.issues,
        };
      }

      const agentContext: ToolContext = {
        signal: context.signal,
        toolCallId: context.toolCallId,
        onUpdate: context.onUpdate,
      };
      const result = await tool.execute(parsed.data as z.infer<T>, agentContext);
      return normalizeAgentToolResult(result);
    },
  };
}

export async function executeVoiceToolCall(
  options: ExecuteVoiceToolCallOptions,
): Promise<VoiceToolResult> {
  const tool = options.tools.find((candidate) => candidate.name === options.call.name);
  if (!tool) {
    return createErrorResult(options.call, {
      type: "tool_not_found",
      message: `Tool not found: ${options.call.name}`,
    });
  }

  const confirmation = await resolveConfirmation(tool, options.call, options.confirmation);
  if (!confirmation.approved) {
    return createErrorResult(options.call, {
      type: "tool_confirmation_denied",
      message: confirmation.reason,
    });
  }

  if (!tool.execute) {
    return createErrorResult(options.call, {
      type: "tool_execution_failed",
      message: `Tool has no executor: ${tool.name}`,
    });
  }

  try {
    const abortController = new AbortController();
    const signal = options.signal ?? abortController.signal;
    const content = await tool.execute(options.call.args, {
      signal,
      toolCallId: options.call.id,
      confirmation: options.confirmation,
      onUpdate: options.onUpdate,
    });
    return {
      toolCallId: options.call.id,
      name: options.call.name,
      content,
    };
  } catch (error) {
    return createErrorResult(options.call, {
      type: "tool_execution_failed",
      message: error instanceof Error ? error.message : "Tool execution failed",
      cause: error,
    });
  }
}

function zodToJsonSchemaObject(schema: z.ZodType): JsonObject {
  const jsonSchema = z.toJSONSchema(schema) as JsonObject;
  const { $schema: _schema, ...rest } = jsonSchema;
  return rest;
}

function normalizeAgentToolResult(result: ToolExecuteResult): VoiceToolExecutionResult {
  if (typeof result === "string") {
    return result;
  }
  if (typeof result.content === "string") {
    if (result.details === undefined) {
      return result.content;
    }
    return { content: result.content, details: result.details };
  }
  return { content: result.content, details: result.details };
}

async function resolveConfirmation(
  tool: VoiceTool,
  call: VoiceToolCall,
  confirmation: VoiceToolContext["confirmation"],
): Promise<ToolConfirmationDecision> {
  const policy = tool.confirmation ?? "never";
  if (policy === "never") {
    return { approved: true };
  }
  if (policy === "destructive" && !tool.destructive) {
    return { approved: true };
  }
  if (typeof policy === "function") {
    return policy({ call, tool });
  }
  if (!confirmation) {
    return {
      approved: false,
      reason: `Tool requires confirmation: ${tool.name}`,
    };
  }
  return confirmation({ call, tool });
}

function createErrorResult(call: VoiceToolCall, error: VoiceToolExecutionError): VoiceToolResult {
  const content: JsonObject = {
    error: error.message,
    type: error.type,
  };
  return {
    toolCallId: call.id,
    name: call.name,
    content,
    isError: true,
  };
}
