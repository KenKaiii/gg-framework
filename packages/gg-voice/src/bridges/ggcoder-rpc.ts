import type { JsonObject, VoiceBridgeCommand, VoiceBridgeEvent, VoiceTool } from "../types.js";

export interface GGCoderRpcMessageSink {
  send(message: JsonObject, signal?: AbortSignal): Promise<void>;
}

export interface GGCoderRpcBridgeOptions {
  readonly sink: GGCoderRpcMessageSink;
  readonly idFactory?: () => string;
}

export interface GGCoderRpcBridge {
  send(command: VoiceBridgeCommand, signal?: AbortSignal): Promise<string>;
  toTool(): VoiceTool;
}

export function createGGCoderRpcBridge(options: GGCoderRpcBridgeOptions): GGCoderRpcBridge {
  const idFactory = options.idFactory ?? (() => `ggcoder_${Date.now()}`);
  return {
    async send(command, signal): Promise<string> {
      const id = idFactory();
      await options.sink.send(toGGCoderRpcCommand(id, command), signal);
      return id;
    },
    toTool(): VoiceTool {
      return createSendToGGCoderTool(this);
    },
  };
}

export function toGGCoderRpcCommand(id: string, command: VoiceBridgeCommand): JsonObject {
  switch (command.type) {
    case "prompt":
      return { id, command: "prompt", text: command.text };
    case "cancel":
      return { id, command: "abort" };
    case "status":
      return { id, command: "get_state" };
    case "new_session":
      return { id, command: "new_session" };
    case "switch_model":
      return { id, command: "switch_model", provider: command.provider, model: command.model };
    case "switch_project":
      return { id, command: "prompt", text: `Switch project to ${command.project}` };
    case "list_projects":
      return { id, command: "prompt", text: "List available GG projects." };
  }
}

export function normalizeGGCoderRpcEvent(message: unknown): VoiceBridgeEvent | null {
  if (!isJsonObject(message)) {
    return null;
  }
  const type = typeof message.type === "string" ? message.type : "";
  switch (type) {
    case "text_delta":
      return { type: "text_delta", text: stringValue(message.text) };
    case "tool_call_start":
      return {
        type: "tool_start",
        id: stringOrUndefined(message.toolCallId),
        name: stringValue(message.name),
      };
    case "tool_call_end":
      return {
        type: "tool_end",
        id: stringOrUndefined(message.toolCallId),
        name: stringValue(message.name),
        isError: message.isError === true,
      };
    case "agent_done":
      return { type: "completion" };
    case "ready":
    case "session_start":
    case "model_change":
      return { type: "status", status: message };
    case "error":
      return { type: "error", error: stringValue(message.message ?? message.error) };
    default:
      return null;
  }
}

function createSendToGGCoderTool(bridge: GGCoderRpcBridge): VoiceTool {
  return {
    name: "send_to_ggcoder",
    description: "Send a prompt or control command to a running ggcoder RPC session.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Prompt text to send to ggcoder." },
      },
      required: ["text"],
    },
    async execute(args, context) {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) {
        return { error: "text is required" };
      }
      const id = await bridge.send({ type: "prompt", text }, context.signal);
      return { status: "sent", id };
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
