import type { Message, ContentPart, ToolResult, Usage } from "@kenkaiiii/gg-ai";

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
  // MiniMax: ~3.2 chars/token (Anthropic-compatible tokenizer)
  minimax: 3.2,
  // Xiaomi MiMo: ~3.7 chars/token (OpenAI-compatible tokenizer)
  mimo: 3.7,
};

/** Default ratio when model family is unknown */
const DEFAULT_CHARS_PER_TOKEN = 3.5;

const PER_MESSAGE_OVERHEAD = 4; // tokens

/** EMA smoothing factor for authoritative-usage calibration observations. */
const CALIBRATION_ALPHA = 0.3;
/** Plausibility bounds for chars-per-token; absorbs tokenizer and content skew. */
const CALIBRATION_MIN_RATIO = 2.0;
const CALIBRATION_MAX_RATIO = 5.0;

/** Active model name, set via setEstimatorModel(). Used to select the right ratio. */
let activeModel = "";

/** Session-observed chars-per-token ratio, blended from provider usage reports. */
let calibratedRatio: number | null = null;

/**
 * Set the active model name for token estimation.
 * Call this when the model changes so estimates use the correct ratio.
 * Switching models resets usage-based calibration (different tokenizer).
 */
export function setEstimatorModel(model: string): void {
  if (model !== activeModel) calibratedRatio = null;
  activeModel = model;
}

/**
 * Feed an authoritative provider usage observation back into the estimator:
 * blends `chars / tokens` into the session ratio via EMA, clamped to sane
 * bounds. Every downstream estimate (compaction trigger, prune budgets)
 * sharpens as real usage data accumulates.
 */
export function calibrateEstimator(chars: number, tokens: number): void {
  if (!Number.isFinite(chars) || !Number.isFinite(tokens) || chars <= 0 || tokens <= 0) return;
  const observed = Math.min(CALIBRATION_MAX_RATIO, Math.max(CALIBRATION_MIN_RATIO, chars / tokens));
  const currentRatio = calibratedRatio ?? getModelCharsPerToken();
  calibratedRatio = currentRatio + CALIBRATION_ALPHA * (observed - currentRatio);
}

/** Current usage-calibrated chars-per-token ratio, or null before any observation. */
export function getCalibratedRatio(): number | null {
  return calibratedRatio;
}

/**
 * Measure the text characters in a message history and whether it contains
 * image/video parts (which inflate tokens-per-char and would skew calibration).
 */
export function measureConversationChars(messages: Message[]): {
  chars: number;
  hasMedia: boolean;
} {
  let chars = 0;
  let hasMedia = false;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content as (ContentPart | ToolResult)[]) {
      if (part.type === "image" || part.type === "video") {
        hasMedia = true;
      } else if (part.type === "tool_call") {
        const serializedArgs = JSON.stringify(part.args);
        chars += part.name.length + (serializedArgs?.length ?? 0);
      } else if (part.type === "tool_result") {
        const tr = part as ToolResult;
        if (typeof tr.content === "string") {
          chars += tr.content.length;
        } else {
          for (const block of tr.content) {
            if (block.type === "text") chars += block.text.length;
            else hasMedia = true;
          }
        }
      } else if ("text" in part && typeof part.text === "string") {
        chars += part.text.length;
      }
    }
  }
  return { chars, hasMedia };
}

/**
 * Calibrate from a provider usage report anchored to a message history using
 * its authoritative total input tokens (uncached + cache read/write). Skips
 * histories containing image/video parts.
 */
export function calibrateEstimatorFromUsage(history: Message[], usage: Usage): void {
  const { chars, hasMedia } = measureConversationChars(history);
  if (hasMedia) return;
  const totalInputTokens = usage.inputTokens + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  calibrateEstimator(chars, totalInputTokens);
}

function getModelCharsPerToken(): number {
  if (!activeModel) return DEFAULT_CHARS_PER_TOKEN;
  const lower = activeModel.toLowerCase();
  for (const [prefix, ratio] of Object.entries(MODEL_FAMILY_RATIOS)) {
    if (lower.startsWith(prefix)) return ratio;
  }
  return DEFAULT_CHARS_PER_TOKEN;
}

function getCharsPerToken(): number {
  return calibratedRatio ?? getModelCharsPerToken();
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
        if (typeof tr.content === "string") {
          tokens += estimateTokens(tr.content);
        } else {
          for (const block of tr.content) {
            if (block.type === "text") {
              tokens += estimateTokens(block.text);
            } else {
              // Image: estimate ~1500 tokens per image (Anthropic rough mean)
              tokens += 1500;
            }
          }
        }
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
