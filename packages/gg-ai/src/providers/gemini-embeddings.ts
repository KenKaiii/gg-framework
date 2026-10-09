/**
 * Gemini embeddings through the native Gemini API
 * (`POST {baseUrl}/models/{model}:batchEmbedContents`, API-key auth via
 * `x-goog-api-key`). Docs: https://ai.google.dev/api/embeddings and
 * https://ai.google.dev/gemini-api/docs/embeddings.
 *
 * This is the Gemini API (AI Studio key), not the Code Assist endpoint that
 * gg-ai's Gemini chat transport uses with Google OAuth — Code Assist has no
 * embeddings API, so an OAuth access token won't work here.
 */
import { GGAIError, ProviderError } from "../errors.js";
import type {
  EmbedInputType,
  ProviderEmbedRequest,
  ProviderEmbedResponse,
} from "../embed-types.js";
import { isRecord, joinUrl, postJson } from "../utils/json-post.js";
import { mergeProviderOptions } from "../utils/provider-options.js";

export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** `batchEmbedContents` rejects more than 100 requests per call
 *  ("at most 100 requests can be in one batch"). */
export const GEMINI_EMBED_BATCH_SIZE = 100;

const TASK_TYPES: Record<EmbedInputType, string> = {
  query: "RETRIEVAL_QUERY",
  document: "RETRIEVAL_DOCUMENT",
};

/**
 * `gemini-embedding-2` doesn't accept a task type: Google's docs say to put the
 * task in the text instead (`task: search result | query: …`). gg-ai doesn't
 * rewrite caller text, so `inputType` is ignored for it.
 */
function supportsTaskType(model: string): boolean {
  return !/^gemini-embedding-2(?:$|[-.@])/.test(model);
}

export async function embedGemini(request: ProviderEmbedRequest): Promise<ProviderEmbedResponse> {
  if (!request.apiKey) {
    throw new GGAIError("Gemini embeddings need a Gemini API key (apiKey).", {
      source: "auth",
      hint: "Create a key in Google AI Studio. Gemini Code Assist sign-in can't be used for embeddings.",
    });
  }
  const model = request.model.replace(/^models\//, "");
  const resource = `models/${model}`;
  const taskType =
    request.inputType && supportsTaskType(model) ? TASK_TYPES[request.inputType] : undefined;
  const embedContentConfig = {
    ...(taskType ? { taskType } : {}),
    ...(request.dimensions !== undefined ? { outputDimensionality: request.dimensions } : {}),
  };
  const body = mergeProviderOptions(
    {
      requests: request.input.map((text) => ({
        model: resource,
        content: { parts: [{ text }] },
        ...(Object.keys(embedContentConfig).length > 0 ? { embedContentConfig } : {}),
      })),
    },
    request.providerOptions,
  );

  const { json, requestId } = await postJson({
    provider: "gemini",
    url: joinUrl(request.baseUrl ?? GEMINI_API_BASE_URL, `${resource}:batchEmbedContents`),
    headers: { "Content-Type": "application/json", "x-goog-api-key": request.apiKey },
    body,
    fetch: request.fetch,
    signal: request.signal,
    secrets: [request.apiKey],
  });

  const invalid = (detail: string): ProviderError =>
    new ProviderError("gemini", `Invalid embeddings response: ${detail}.`, {
      ...(requestId ? { requestId } : {}),
    });
  if (!isRecord(json) || !Array.isArray(json.embeddings)) {
    throw invalid("missing `embeddings` array");
  }
  // Documented to be "in the same order as provided in the batch request".
  const embeddings = json.embeddings.map((entry: unknown) => {
    if (!isRecord(entry) || !Array.isArray(entry.values)) {
      throw invalid("an entry has no `values` array");
    }
    return entry.values as number[];
  });

  const usage = json.usageMetadata;
  const promptTokens = isRecord(usage) ? usage.promptTokenCount : undefined;
  return {
    embeddings,
    model,
    ...(typeof promptTokens === "number" && Number.isFinite(promptTokens)
      ? { usage: { inputTokens: promptTokens } }
      : {}),
  };
}
