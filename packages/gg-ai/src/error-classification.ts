import { isHardBillingMessage } from "./errors.js";

/**
 * Provider-error classification — tags a raw provider error message with a
 * machine-routable prefix so callers route on intent instead of regexing JSON.
 *
 * This lives in gg-ai (next to `formatError` / `isHardBillingMessage`) so every
 * provider-wording change is a one-file edit. The billing check reuses
 * `isHardBillingMessage` so billing substrings have exactly one home.
 *
 * Each provider phrases the same condition differently — a single substring
 * check would miss most real cases.
 *
 * Provider attribution (with example messages):
 *  - OpenAI Chat Completions: "This model's maximum context length is 128000 tokens…"
 *  - OpenAI Responses / Codex: "Your input exceeds the context window of this model"
 *  - OpenAI structured code:    error.code = "context_length_exceeded"
 *  - Anthropic (token overflow): "prompt is too long: 213462 tokens > 200000 maximum"
 *  - Anthropic (HTTP 413 byte):  error.type = "request_too_large"
 *  - Google / Gemini:            "The input token count (1196265) exceeds the maximum number of tokens allowed"
 *  - xAI / Grok:                 "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 *  - Mistral:                    "Prompt contains X tokens … too large for model with Y maximum context length"
 *  - Amazon Bedrock:             "input is too long for requested model"
 *  - OpenRouter:                 "This endpoint's maximum context length is X tokens. However, you requested Y"
 *  - Groq:                       "Please reduce the length of the messages or completion"
 *  - DeepSeek / GLM / MiniMax / Moonshot / Xiaomi: OpenAI-compatible — reuse `context_length_exceeded` and the maximum-context-length wording.
 */
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /context_length_exceeded/i,
  /context length exceeded/i,
  /context window/i, // OpenAI Codex / Responses
  /maximum context length/i, // OpenAI / OpenRouter / Mistral
  /prompt is too long/i, // Anthropic
  /request_too_large/i, // Anthropic HTTP 413
  /input is too long/i, // Bedrock
  /input token count.*exceeds the maximum/i, // Gemini
  /maximum prompt length/i, // xAI / Grok
  /reduce the length of the messages/i, // Groq
  /too large for model/i, // Mistral
  /token limit/i, // generic
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[ _-]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /tokens per minute/i,
  /requests per minute/i,
];

const PROVIDER_TRANSIENT_PATTERNS: RegExp[] = [
  /\b5\d\d\b/,
  /api_error/i,
  /server_error/i,
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /overloaded/i,
  /\b529\b/,
];

/**
 * Billing/quota substrings that `isHardBillingMessage` does not already cover.
 * Kept minimal: shared billing wording lives in `isHardBillingMessage`; these
 * are transport-level signals (HTTP 402, "payment required") specific to the
 * classifier's routing needs.
 */
const BILLING_PATTERNS: RegExp[] = [
  /payment required/i,
  /\b402\b/,
  /quota_exceeded/i, // underscore variant not in isHardBillingMessage
  /credit balance/i,
];

const AUTH_PATTERNS: RegExp[] = [
  /invalid[ _]api[ _]key/i,
  /unauthorized/i,
  /\b401\b/,
  /authentication[ _]failed/i,
  /please run \/login/i, // Anthropic Claude Code-style hint
];

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(message));
}

/**
 * Inspect a raw provider error message and tag it with a clearer, actionable
 * prefix so a worker orchestrator can route on intent instead of regexing JSON.
 * Preserves the original message verbatim after the prefix — helpful for
 * debugging.
 *
 * Order matters: context-overflow is checked first because some providers wrap
 * overflow errors in HTTP 429 envelopes; we want the structural meaning, not
 * the transport status. Billing comes before auth/rate-limit because "402
 * Payment Required" must not be mis-routed as a rate-limit retry.
 */
export function classifyProviderError(message: string): string {
  if (matchesAny(message, CONTEXT_OVERFLOW_PATTERNS)) {
    return `[context_overflow] Worker context window exceeded — the conversation is too large to continue. Recovery: call reset_worker(project) to wipe history, then re-prompt with the task. Re-prompting WITHOUT reset will fail the same way.\n\nOriginal: ${message}`;
  }
  if (isHardBillingMessage(message) || matchesAny(message, BILLING_PATTERNS)) {
    return `[billing] Provider billing/quota issue. Recovery: surface to the user — they need to top up or switch providers. Do NOT retry.\n\nOriginal: ${message}`;
  }
  if (matchesAny(message, AUTH_PATTERNS)) {
    return `[auth] Provider authentication failed. Recovery: surface to the user — they need to re-login. Do NOT retry.\n\nOriginal: ${message}`;
  }
  if (matchesAny(message, RATE_LIMIT_PATTERNS)) {
    return `[rate_limited] Provider rate limit hit. Recovery: wait ~30s, then re-prompt the same worker (no reset needed).\n\nOriginal: ${message}`;
  }
  if (matchesAny(message, PROVIDER_TRANSIENT_PATTERNS)) {
    return `[provider_transient] Provider server-side/transient error. Recovery: wait briefly, then re-prompt the same worker (no reset needed). If it keeps happening, switch models/providers or check provider status.\n\nOriginal: ${message}`;
  }
  return message;
}
