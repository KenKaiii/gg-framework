import {
  query as sdkQuery,
  type Options as SdkOptions,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ContentPart,
  Message,
  StreamResponse,
  ThinkingLevel,
  UserMessage,
} from "@kenkaiiii/gg-ai";
import { claudeCodeEnv, resolveClaudeCodeBinary, type AuthStorage } from "@kenkaiiii/gg-core";
import {
  effortForThinking,
  fromSdkContentBlock,
  renderTranscript,
  toSdkUserContent,
  toSdkUserMessage,
  toStopReason,
  toUsage,
} from "./events.js";
import type { ClaudeCodeQuery } from "./loop.js";

/** How to start Claude Code for this session. */
export interface ClaudeCodeProcess {
  executable: string;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Test seam for the SDK's `query()`. */
  query?: ClaudeCodeQuery;
}

/**
 * Claude Code process settings when this session runs on a Claude
 * subscription (Anthropic + the Claude Code sign-in marker), else null.
 */
export async function resolveClaudeCodeProcess(
  authStorage: Pick<AuthStorage, "hasClaudeCodeLogin">,
  provider: string,
  cwd: string,
): Promise<ClaudeCodeProcess | null> {
  if (provider !== "anthropic" || !(await authStorage.hasClaudeCodeLogin())) return null;
  const executable = resolveClaudeCodeBinary();
  if (!executable) {
    throw new Error(
      "Claude Code isn't installed anymore. Sign in with Claude again to restore it.",
    );
  }
  return { executable, cwd, env: claudeCodeEnv() };
}

export interface ClaudeCodeCompleteOptions extends ClaudeCodeProcess {
  model: string;
  /** System messages become the system prompt; the rest is sent as one user turn. */
  messages: Message[];
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  /** Claude Code built-in tools this call may use (e.g. `WebSearch`). Default none. */
  builtinTools?: string[];
  /** Default 1; raise it when `builtinTools` must run before the answer. */
  maxTurns?: number;
}

export interface ClaudeCodeCompletion extends StreamResponse {
  /** Structured outputs of the built-in tools that ran, in order. */
  toolOutputs: unknown[];
}

const MAX_CONTEXT_CHARS = 1_000_000;

function promptContent(messages: Message[]): SDKUserMessage["message"]["content"] {
  const turns = messages.filter((m) => m.role !== "system");
  const last = turns.at(-1);
  const tail = last?.role === "user" ? [last] : [];
  const prior = turns.slice(0, turns.length - tail.length);
  const content = tail.flatMap((m) => toSdkUserContent((m as UserMessage).content));
  if (prior.length > 0) {
    content.unshift({ type: "text", text: renderTranscript(prior, MAX_CONTEXT_CHARS) });
  }
  return content.length > 0 ? content : [{ type: "text", text: "Continue." }];
}

/** A single model call through Claude Code: no tools of ours, no saved session. */
export async function claudeCodeComplete(
  opts: ClaudeCodeCompleteOptions,
): Promise<ClaudeCodeCompletion> {
  opts.signal?.throwIfAborted();
  const system = opts.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content as string)
    .join("\n\n");
  const first = toSdkUserMessage(
    promptContent(opts.messages) as Parameters<typeof toSdkUserMessage>[0],
  );
  const input = (async function* () {
    yield first;
  })();

  const builtins = opts.builtinTools ?? [];
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const effort = effortForThinking(opts.thinking);
  const sdkOptions: SdkOptions = {
    cwd: opts.cwd,
    model: opts.model,
    systemPrompt: { type: "custom", prompt: system },
    tools: builtins,
    canUseTool: async (toolName, toolInput) =>
      builtins.includes(toolName)
        ? { behavior: "allow", updatedInput: toolInput }
        : { behavior: "deny", message: `${toolName} is not available here.` },
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    maxTurns: opts.maxTurns ?? 1,
    pathToClaudeCodeExecutable: opts.executable,
    env: opts.env,
    abortController,
    ...(effort
      ? { thinking: { type: "adaptive" as const }, effort }
      : { thinking: { type: "disabled" as const } }),
  };

  const content: ContentPart[] = [];
  const toolOutputs: unknown[] = [];
  let syntheticError: string | undefined;
  const q = (opts.query ?? sdkQuery)({ prompt: input, options: sdkOptions });
  try {
    for await (const message of q) {
      if (message.type === "assistant" && !message.parent_tool_use_id) {
        const blocks = message.message.content as unknown as Record<string, unknown>[];
        if ((message.message as { model?: string }).model === "<synthetic>") {
          syntheticError = blocks.map((b) => (b.type === "text" ? String(b.text) : "")).join("");
          continue;
        }
        for (const block of blocks) content.push(fromSdkContentBlock(block));
      } else if (message.type === "user" && message.tool_use_result !== undefined) {
        toolOutputs.push(message.tool_use_result);
      } else if (message.type === "result") {
        if (message.subtype !== "success" && message.subtype !== "error_max_turns") {
          throw new Error(
            message.errors.join("\n") ||
              syntheticError ||
              `Claude Code stopped: ${message.subtype}`,
          );
        }
        if (message.subtype === "success" && message.is_error) {
          throw new Error(message.result || syntheticError || "Claude Code request failed.");
        }
        return {
          message: { role: "assistant", content },
          stopReason: toStopReason(message.stop_reason),
          usage: toUsage(message.usage),
          toolOutputs,
        };
      }
    }
  } catch (error) {
    opts.signal?.throwIfAborted();
    throw error;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    q.close();
  }
  opts.signal?.throwIfAborted();
  throw new Error(syntheticError || "Claude Code ended without a reply.");
}
