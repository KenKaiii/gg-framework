import type { StreamOptions } from "./types.js";
import { GGAIError } from "./errors.js";
import type { StreamResult } from "./utils/event-stream.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamOpenAI } from "./providers/openai.js";
import { streamOpenAICodex } from "./providers/openai-codex.js";
import { providerRegistry } from "./provider-registry.js";

/** Z.AI coding API endpoint — the primary endpoint for all GLM models. */
const GLM_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

// ── Register built-in providers ────────────────────────────

providerRegistry.register("anthropic", {
  stream: (options) => streamAnthropic(options),
});

providerRegistry.register("xiaomi", {
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? "https://token-plan-sgp.xiaomimimo.com/v1",
      webSearch: false,
    }),
});

providerRegistry.register("openai", {
  stream: (options) => {
    // Use codex endpoint for OAuth tokens (have accountId)
    if (options.accountId) {
      return streamOpenAICodex(options);
    }
    return streamOpenAI(options);
  },
});

providerRegistry.register("glm", {
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? GLM_CODING_BASE_URL,
    }),
});

providerRegistry.register("moonshot", {
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.moonshot.ai/v1",
    }),
});

providerRegistry.register("minimax", {
  stream: (options) =>
    streamAnthropic({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.minimax.io/anthropic",
      // MiniMax's Anthropic-compatible API does not support Anthropic-specific
      // server tools (web_search), context_management, or server-side tools.
      webSearch: false,
      compaction: false,
      clearToolUses: false,
      serverTools: undefined,
    }),
});

// ── Public API ─────────────────────────────────────────────

/**
 * Unified streaming entry point. Returns a StreamResult that is both
 * an async iterable (for streaming events) and thenable (await for
 * the final response).
 *
 * Providers are resolved via the provider registry. Built-in providers
 * (anthropic, openai, glm, moonshot) are registered at module load.
 * Extensions can register custom providers via `providerRegistry.register()`.
 *
 * ```ts
 * // Stream events
 * for await (const event of stream({ provider: "anthropic", model: "claude-sonnet-4-6", messages })) {
 *   if (event.type === "text_delta") process.stdout.write(event.text);
 * }
 *
 * // Or just await the final message
 * const response = await stream({ provider: "openai", model: "gpt-4.1", messages });
 * ```
 */
export function stream(options: StreamOptions): StreamResult {
  const entry = providerRegistry.get(options.provider);
  if (!entry) {
    throw new GGAIError(
      `Unknown provider: "${options.provider}". Registered: ${providerRegistry.list().join(", ")}`,
    );
  }
  return entry.stream(options);
}
