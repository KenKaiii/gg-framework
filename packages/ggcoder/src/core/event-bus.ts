import type { AgentEvent } from "@kenkaiiii/gg-agent";
import type { SubAgentSnapshot } from "./subagent-manager.js";

// ── Event Map ──────────────────────────────────────────────

export interface BusEventMap {
  // Agent events (forwarded from agentLoop)
  text_delta: { text: string };
  thinking_delta: { text: string };
  tool_call_start: { toolCallId: string; name: string; args: Record<string, unknown> };
  tool_call_update: { toolCallId: string; update: unknown };
  tool_call_end: {
    toolCallId: string;
    result: string;
    isError: boolean;
    durationMs: number;
    /** Tool-specific extras (e.g. screenshot/read image previews). */
    details?: unknown;
    /** Consecutive count for a repeated schema-validation failure; see AgentToolCallEndEvent. */
    invalidArgAttempt?: number;
  };
  turn_end: {
    turn: number;
    stopReason: string;
    usage: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number };
  };
  /** Step boundary: every message for this turn is in the array. Hosts persist here. */
  checkpoint: {
    turn: number;
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
  max_turns: { totalTurns: number; maxTurns: number };
  /** Turn budget was exhausted but extended because the run showed progress. */
  turn_budget_extended: { turn: number; grantedTurns: number; extension: number };
  truncated: {
    reason: "max_tokens" | "refusal" | "provider_error" | "empty_response";
    continued: boolean;
  };
  error: { error: Error };

  // Server tool events
  server_tool_call: { id: string; name: string; input: unknown };
  server_tool_result: { toolUseId: string; resultType: string; data: unknown };

  /** Informational edit feedback, not a completion gate or a draft replacement. */
  diagnostics: { text: string };

  // Agent self-correction hooks (ideal review / verification / loop-break /
  // re-grounding). Carries only the semantic kind; the presentation layer owns
  // text + color.
  hook: {
    kind: "ideal" | "verification" | "loop_break" | "regrounding";
    coverageExpected?: string[];
    coverageMissing?: string[];
    verificationReason?: "recheck" | "check_review";
  };

  /** A pre-final hook would fire if the agent stopped right now: the Ideal
   *  review, or the verification gate. Emitted as soon as the run crosses the
   *  gate — i.e. BEFORE the candidate final answer streams — so a client can
   *  hold that answer back instead of painting a draft the hook then discards. */
  hook_armed: { kind: "ideal" | "verification"; armed: boolean };

  // Persistent async child lifecycle (bounded metadata/output snapshot).
  subagent_state: SubAgentSnapshot;

  /** Queued user steering was consumed into the run at a turn boundary.
   *  `count` is the remaining depth. Lets clients clear the "queued" affordance
   *  the moment the agent picks a message up, instead of holding it until
   *  run_end — the message is already in the loop long before the run ends. */
  queue_drained: { count: number };

  // Session lifecycle
  session_start: { sessionId: string };
  model_change: { provider: string; model: string; supportsVideo?: boolean };
  compaction_start: { messageCount: number };
  compaction_end: {
    compacted: boolean;
    originalCount: number;
    newCount: number;
    selectionStrategy?: "query_aware" | "fallback";
    selectedMessages?: number;
    selectedTokens?: number;
    droppedMessages?: number;
    queryTerms?: number;
    selectionFallback?: string;
  };

  // Branch events
  branch_created: { leafId: string; messagesKept: number };

  // Input events
  user_input: { content: string };
  slash_command: { name: string; args: string };
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
          details: event.details,
          invalidArgAttempt: event.invalidArgAttempt,
        });
        break;
      case "turn_end":
        this.emit("turn_end", {
          turn: event.turn,
          stopReason: event.stopReason,
          usage: event.usage,
        });
        break;
      case "checkpoint":
        this.emit("checkpoint", { turn: event.turn });
        break;
      case "agent_done":
        this.emit("agent_done", {
          totalTurns: event.totalTurns,
          totalUsage: event.totalUsage,
        });
        break;
      case "max_turns":
        this.emit("max_turns", {
          totalTurns: event.totalTurns,
          maxTurns: event.maxTurns,
        });
        break;
      case "turn_budget_extended":
        this.emit("turn_budget_extended", {
          turn: event.turn,
          grantedTurns: event.grantedTurns,
          extension: event.extension,
        });
        break;
      case "truncated":
        this.emit("truncated", {
          reason: event.reason,
          continued: event.continued,
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
