import type { Message } from "@kenkaiiii/gg-ai";
import { buildLanguageUpdateMessage } from "../core/env-delta.js";
import type { LanguageId } from "../core/language-detector.js";

export type LanguagePackUpdate =
  { kind: "rebuild" } | { kind: "append"; message: Message } | { kind: "defer" } | { kind: "none" };

/**
 * How the terminal app takes on newly detected languages without throwing
 * away the prompt cache (same rule as AgentSession.announceNewLanguages):
 * before any reply nothing is cached yet, so the system prompt is rebuilt;
 * after that the update goes in as a hidden message, and only between turns —
 * never mid-run, where a user message would split a tool call from its result.
 */
export function planLanguagePackUpdate(opts: {
  added: ReadonlySet<LanguageId>;
  cwd: string;
  hasReply: boolean;
  betweenTurns: boolean;
}): LanguagePackUpdate {
  if (opts.added.size === 0) return { kind: "none" };
  if (!opts.hasReply) return { kind: "rebuild" };
  if (!opts.betweenTurns) return { kind: "defer" };
  const message = buildLanguageUpdateMessage(new Set(opts.added), opts.cwd);
  return message ? { kind: "append", message } : { kind: "rebuild" };
}
