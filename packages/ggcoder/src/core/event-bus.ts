import type { AgentEvent } from "@kenkaiiii/gg-agent";

// ── Event Map ──────────────────────────────────────────────

export interface BusEventMap {
  // Agent events (forwarded from agentLoop)
  text_delta: { text: string };
  thinking_delta: { text: string };
  tool_call_start: { toolCallId: string; name: string; args: Record<string, unknown> };
  tool_call_update: { toolCallId: string; update: unknown };
  tool_call_end: { toolCallId: string; result: string; isError: boolean; durationMs: number };
  turn_end: {
    turn: number;
    stopReason: string;
    usage: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number };
  };
  agent_done: {
    totalTurns: number;
    totalUsage: {
      inputTokens: number;
      outputTokens: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
  error: { error: Error };

  // Server tool events
  server_tool_call: { id: string; name: string; input: unknown };
  server_tool_result: { toolUseId: string; resultType: string; data: unknown };

  // Session lifecycle
  session_start: { sessionId: string };
  model_change: { provider: string; model: string };
  compaction_start: { messageCount: number };
  compaction_end: { originalCount: number; newCount: number };

  // Branch events
  branch_created: { leafId: string; messagesKept: number };

  // Input events
  user_input: { content: string };
  slash_command: { name: string; args: string };

  // Remote control events
  remote_prompt: { content: string; commandId: string };
}

type EventKey = keyof BusEventMap;
type EventHandler<K extends EventKey> = (payload: BusEventMap[K]) => void;

// ── EventBus ───────────────────────────────────────────────

export class EventBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners = new Map<string, Set<(...args: any[]) => void>>();

  on<K extends EventKey>(event: K, handler: EventHandler<K>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off<K extends EventKey>(event: K, handler: EventHandler<K>): void {
    this.listeners.get(event)?.delete(handler);
  }

  emit<K extends EventKey>(event: K, payload: BusEventMap[K]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(payload);
    }
  }

  once<K extends EventKey>(event: K, handler: EventHandler<K>): () => void {
    const wrapper: EventHandler<K> = (payload) => {
      this.off(event, wrapper);
      handler(payload);
    };
    return this.on(event, wrapper);
  }

  /** Remove all listeners, freeing closures that may retain large scopes. */
  removeAllListeners(): void {
    for (const set of this.listeners.values()) {
      set.clear();
    }
    this.listeners.clear();
  }

  forwardAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        this.emit("text_delta", { text: event.text });
        break;
      case "thinking_delta":
        this.emit("thinking_delta", { text: event.text });
        break;
      case "tool_call_start":
        this.emit("tool_call_start", {
          toolCallId: event.toolCallId,
          name: event.name,
          args: event.args,
        });
        break;
      case "tool_call_update":
        this.emit("tool_call_update", {
          toolCallId: event.toolCallId,
          update: event.update,
        });
        break;
      case "tool_call_end":
        this.emit("tool_call_end", {
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
          durationMs: event.durationMs,
        });
        break;
      case "turn_end":
        this.emit("turn_end", {
          turn: event.turn,
          stopReason: event.stopReason,
          usage: event.usage,
        });
        break;
      case "agent_done":
        this.emit("agent_done", {
          totalTurns: event.totalTurns,
          totalUsage: event.totalUsage,
        });
        break;
      case "server_tool_call":
        this.emit("server_tool_call", {
          id: event.id,
          name: event.name,
          input: event.input,
        });
        break;
      case "server_tool_result":
        this.emit("server_tool_result", {
          toolUseId: event.toolUseId,
          resultType: event.resultType,
          data: event.data,
        });
        break;
      case "error":
        this.emit("error", { error: event.error });
        break;
    }
  }
}
