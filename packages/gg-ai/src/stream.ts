import type { StreamOptions } from "./types.js";
import { GGAIError } from "./errors.js";
import type { StreamResult } from "./utils/event-stream.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamOpenAI } from "./providers/openai.js";
import { streamOpenAICodex } from "./providers/openai-codex.js";

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
      return streamOpenAI({
        ...options,
        baseUrl: options.baseUrl ?? "https://api.z.ai/api/coding/paas/v4",
      });
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
