import type { StreamOptions } from "./types.js";
import { GGAIError, ProviderError } from "./errors.js";
import { StreamResult } from "./utils/event-stream.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamOpenAI } from "./providers/openai.js";
import { streamOpenAICodex } from "./providers/openai-codex.js";

/** Z.AI has two API systems — Coding Plan (subscription) and regular (pay-per-token). */
const GLM_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const GLM_REGULAR_BASE_URL = "https://api.z.ai/api/paas/v4";

/**
 * Unified streaming entry point. Returns a StreamResult that is both
 * an async iterable (for streaming events) and thenable (await for
 * the final response).
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
  switch (options.provider) {
    case "anthropic":
      return streamAnthropic(options);
    case "openai":
      // Use codex endpoint for OAuth tokens (have accountId)
      if (options.accountId) {
        return streamOpenAICodex(options);
      }
      return streamOpenAI(options);
    case "glm":
      // If user set an explicit baseUrl, use it directly — no fallback
      if (options.baseUrl) {
        return streamOpenAI(options);
      }
      return streamGLMWithFallback(options);
    case "moonshot":
      return streamOpenAI({
        ...options,
        baseUrl: options.baseUrl ?? "https://api.moonshot.ai/v1",
      });
    default:
      throw new GGAIError(
        `Unknown provider: ${options.provider as string}. Supported: "anthropic", "openai", "glm", "moonshot"`,
      );
  }
}

/**
 * Try the Coding Plan endpoint first; if it fails with a 404 / model-not-found
 * error, fall back to the regular pay-per-token endpoint. This handles users
 * who have a regular Z.AI API key instead of a Coding Plan subscription.
 */
function streamGLMWithFallback(options: StreamOptions): StreamResult {
  const result = new StreamResult();

  runGLMWithFallback(options, result).catch((err) => {
    result.abort(err instanceof Error ? err : new Error(String(err)));
  });

  return result;
}

async function runGLMWithFallback(options: StreamOptions, result: StreamResult): Promise<void> {
  // Try coding endpoint first (most users have Coding Plan)
  const codingResult = streamOpenAI({ ...options, baseUrl: GLM_CODING_BASE_URL });

  try {
    // Attempt to consume the coding endpoint stream
    for await (const event of codingResult) {
      result.push(event);
    }
    // Stream completed successfully — forward the final response
    const response = await codingResult.response;
    result.complete(response);
  } catch (err) {
    if (isEndpointMismatchError(err)) {
      // Coding endpoint rejected the key — retry with regular endpoint
      const regularResult = streamOpenAI({ ...options, baseUrl: GLM_REGULAR_BASE_URL });
      try {
        for await (const event of regularResult) {
          result.push(event);
        }
        const response = await regularResult.response;
        result.complete(response);
      } catch (fallbackErr) {
        result.abort(fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
      }
    } else {
      result.abort(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/** Detect errors that indicate the API key doesn't match the endpoint type. */
function isEndpointMismatchError(err: unknown): boolean {
  if (err instanceof ProviderError) {
    // 404 = model/endpoint not found, 403 = access denied for this endpoint
    if (err.statusCode === 404 || err.statusCode === 403) return true;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("model_not_found") ||
      msg.includes("does not exist") ||
      /model.*not.*exist/.test(msg) ||
      /not have access/.test(msg) ||
      msg.includes("resource not found")
    ) {
      return true;
    }
  }
  return false;
}
