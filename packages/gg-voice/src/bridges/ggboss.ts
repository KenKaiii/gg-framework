import type { JsonObject, VoiceBridgeCommand, VoiceBridgeEvent, VoiceTool } from "../types.js";

export interface GGBossPromptTarget {
  enqueueUserMessage(text: string): Promise<void> | void;
}

export interface GGBossBridge {
  send(command: VoiceBridgeCommand, signal?: AbortSignal): Promise<VoiceBridgeEvent>;
  toTool(): VoiceTool;
}

export function createGGBossBridge(target: GGBossPromptTarget): GGBossBridge {
  return {
    async send(command, signal): Promise<VoiceBridgeEvent> {
      throwIfAborted(signal);
      if (command.type !== "prompt") {
        return {
          type: "error",
          error: `Unsupported GGBoss bridge command: ${command.type}`,
        };
      }
      await target.enqueueUserMessage(command.text);
      return { type: "task_dispatch", text: command.text };
    },
    toTool(): VoiceTool {
      return createSendToGGBossTool(this);
    },
  };
}

export function createRelayGGBossTool(
  send: (command: VoiceBridgeCommand) => Promise<JsonObject>,
): VoiceTool {
  return {
    name: "send_to_ggboss",
    description: "Send a prompt to a GG Boss orchestrator relay.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Prompt text to send to GG Boss." },
      },
      required: ["text"],
    },
    async execute(args) {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) {
        return { error: "text is required" };
      }
      return send({ type: "prompt", text });
    },
  };
}

function createSendToGGBossTool(bridge: GGBossBridge): VoiceTool {
  return {
    name: "send_to_ggboss",
    description: "Send a prompt to an in-process GG Boss orchestrator.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Prompt text to send to GG Boss." },
      },
      required: ["text"],
    },
    async execute(args, context) {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) {
        return { error: "text is required" };
      }
      const event = await bridge.send({ type: "prompt", text }, context.signal);
      return event;
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("GGBoss bridge command aborted");
  }
}
