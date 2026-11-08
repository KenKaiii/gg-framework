// Core
export { Agent, AgentStream } from "./agent.js";
export {
  agentLoop,
  capToolResults,
  cancelledBeforeStartText,
  indeterminateOutcomeText,
  isAbortError,
  isContextOverflow,
  isBillingError,
  isInterruptibleTool,
  markSteerInterrupted,
  PREEMPT_GRACE_MS,
  STEER_INTERRUPTED_TEXT,
  isUsageLimitError,
  repairToolPairingAdjacent,
  setStreamDiagnostic,
} from "./agent-loop.js";
export type { StreamDiagnosticFn } from "./agent-loop.js";
export {
  StreamRuleMonitor,
  JsonEscapeDecoder,
  buildStreamRuleReminder,
  DEFAULT_STREAM_RULE_MAX_RETRIES,
  DEFAULT_STREAM_RULE_WINDOW_CHARS,
} from "./stream-rules.js";
export type {
  StreamRule,
  StreamRuleScope,
  StreamRuleSource,
  StreamRuleMatch,
  StreamRulesConfig,
} from "./stream-rules.js";
export { isLocalBackendUrl } from "./local-backend.js";
export { argumentHints, unknownToolMessage } from "./tool-call-hints.js";

// Types
export type {
  StructuredToolResult,
  ToolExecuteResult,
  ToolContext,
  ToolExecutionMode,
  AgentTool,
  AgentTextDeltaEvent,
  AgentThinkingDeltaEvent,
  AgentToolCallStartEvent,
  AgentToolCallUpdateEvent,
  AgentToolCallEndEvent,
  AgentToolCallDeltaEvent,
  AgentServerToolCallEvent,
  AgentServerToolResultEvent,
  AgentSteeringMessageEvent,
  AgentFollowUpMessageEvent,
  AgentRetryEvent,
  AgentStreamRuleTriggeredEvent,
  AgentTurnTiming,
  AgentTurnEndEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  AgentEvent,
  TransformContextOptions,
  AgentOptions,
  AgentResult,
} from "./types.js";
