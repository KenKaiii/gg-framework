import type { StreamOptions } from "./types.js";
import { GGAIError } from "./errors.js";
import { StreamResult } from "./utils/event-stream.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamOpenAI } from "./providers/openai.js";
import { streamOpenAICodex } from "./providers/openai-codex.js";
import { providerRegistry } from "./provider-registry.js";

/** Z.AI has two API systems — some accounts work on one, some on the other. */
const GLM_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const GLM_REGULAR_BASE_URL = "https://api.z.ai/api/paas/v4";

// ── Register built-in providers ────────────────────────────

providerRegistry.register("anthropic", {
  stream: (options) => streamAnthropic(options),
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
  stream: (options) => {
    if (options.baseUrl) return streamOpenAI(options);
    return streamGLMWithFallback(options);
  },
});

providerRegistry.register("moonshot", {
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.moonshot.ai/v1",
    }),
});

providerRegistry.register("venice", {
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.venice.ai/api/v1",
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

// ── GLM fallback logic ────────────────────────────────────

/**
 * Try the coding endpoint first; if it fails for any reason, retry with the
 * regular endpoint. Z.AI inconsistently provisions accounts — some work on
 * /api/coding/paas/v4, others on /api/paas/v4, even on the same plan.
 */
function streamGLMWithFallback(options: StreamOptions): StreamResult {
  const result = new StreamResult();

  runGLMWithFallback(options, result).catch((err) => {
    result.abort(err instanceof Error ? err : new Error(String(err)));
  });

  return result;
}

async function runGLMWithFallback(options: StreamOptions, result: StreamResult): Promise<void> {
  const codingResult = streamOpenAI({ ...options, baseUrl: GLM_CODING_BASE_URL });

  try {
    for await (const event of codingResult) {
      result.push(event);
    }
    result.complete(await codingResult.response);
  } catch {
    // Coding endpoint failed — try regular endpoint
    const regularResult = streamOpenAI({ ...options, baseUrl: GLM_REGULAR_BASE_URL });
    try {
      for await (const event of regularResult) {
        result.push(event);
      }
      result.complete(await regularResult.response);
    } catch (fallbackErr) {
      result.abort(fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
    }
  }
}
