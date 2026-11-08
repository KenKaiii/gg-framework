import type { Message } from "@kenkaiiii/gg-ai";
import type { AgentEvent, AgentResult } from "@kenkaiiii/gg-agent";
import { ClaudeCodeLiveSession, type ClaudeCodeLoopOptions } from "./live-session.js";

export type {
  ClaudeCodeLoopOptions,
  ClaudeCodeQuery,
  ClaudeCodeSessionOptions,
} from "./live-session.js";

/**
 * One run on a Claude Code process that is closed afterwards. Long-lived chats
 * keep a {@link ClaudeCodeLiveSession} instead.
 */
export async function* claudeCodeLoop(
  messages: Message[],
  options: ClaudeCodeLoopOptions,
): AsyncGenerator<AgentEvent, AgentResult> {
  const live = new ClaudeCodeLiveSession();
  try {
    return yield* live.run(messages, options);
  } finally {
    live.close("one-shot");
  }
}
