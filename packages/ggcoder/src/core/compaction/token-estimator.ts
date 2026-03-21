import type { Message, ContentPart, ToolResult } from "@kenkaiiii/gg-ai";

/**
 * Model-family-specific chars-per-token ratios.
 * These are empirically measured averages for English text.
 * CJK/code/mixed content will vary, but these are better than a flat 4.0.
 */
const MODEL_FAMILY_RATIOS: Record<string, number> = {
  // Anthropic models: ~3.2 chars/token (BPE tokenizer, slightly more compact)
  claude: 3.2,
  // OpenAI models: ~3.7 chars/token (cl100k_base / o200k_base)
  gpt: 3.7,
  o1: 3.7,
  o3: 3.7,
  o4: 3.7,
  // GLM models: ~2.5 chars/token (mixed CJK/English tokenizer)
  glm: 2.5,
  // Moonshot/Kimi: ~2.8 chars/token (multilingual tokenizer)
  kimi: 2.8,
  moonshot: 2.8,
};

/** Default ratio when model family is unknown */
const DEFAULT_CHARS_PER_TOKEN = 3.5;

const PER_MESSAGE_OVERHEAD = 4; // tokens

/** Active model name, set via setEstimatorModel(). Used to select the right ratio. */
let activeModel = "";

/**
 * Set the active model name for token estimation.
 * Call this when the model changes so estimates use the correct ratio.
 */
export function setEstimatorModel(model: string): void {
  activeModel = model;
}

function getCharsPerToken(): number {
  if (!activeModel) return DEFAULT_CHARS_PER_TOKEN;
  const lower = activeModel.toLowerCase();
  for (const [prefix, ratio] of Object.entries(MODEL_FAMILY_RATIOS)) {
    if (lower.startsWith(prefix)) return ratio;
  }
  return DEFAULT_CHARS_PER_TOKEN;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / getCharsPerToken());
}

export function estimateMessageTokens(message: Message): number {
  let tokens = PER_MESSAGE_OVERHEAD;

  if (typeof message.content === "string") {
    tokens += estimateTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if ("text" in part && typeof part.text === "string") {
        tokens += estimateTokens(part.text);
      } else if ("type" in part && part.type === "tool_call") {
        const tc = part as ContentPart & { type: "tool_call" };
        tokens += estimateTokens(tc.name);
        tokens += estimateTokens(JSON.stringify(tc.args));
      } else if ("type" in part && part.type === "tool_result") {
        const tr = part as unknown as ToolResult;
        tokens += estimateTokens(tr.content);
        // ~1600 tokens per image (Anthropic vision estimate)
        if (tr.images?.length) tokens += tr.images.length * 1600;
      }
    }
  }

  return tokens;
}

export function estimateConversationTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}
