import type { Message, StreamOptions } from "./types.js";
import { GGAIError, VideoUnsupportedError } from "./errors.js";
import type { StreamResult } from "./utils/event-stream.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamOpenAI } from "./providers/openai.js";
import { streamOpenAICodex } from "./providers/openai-codex.js";
import { streamGemini } from "./providers/gemini.js";
import { GEMINI_EMBED_BATCH_SIZE, embedGemini } from "./providers/gemini-embeddings.js";
import {
  embedOpenAICompatible,
  rerankCohereCompatible,
} from "./providers/openai-compat-retrieval.js";
import { providerRegistry } from "./provider-registry.js";
import {
  clampProviderContextImages,
  dropInvalidToolCalls,
  toolCallNameRuleFor,
} from "./providers/transform.js";
import { sanitizeMessagesForWire } from "./utils/well-formed.js";
import { observePreparedContext } from "./utils/context-observation.js";

/** OpenAI's documented cap: an embeddings `input` array may hold at most 2048 entries. */
const OPENAI_EMBED_BATCH_SIZE = 2048;

/**
 * OpenRouter documents no per-request input cap for `/embeddings`, and it
 * forwards to upstreams that have their own (Gemini: 100). 64 is a conservative
 * default proven in production; callers can raise it with `batchSize`.
 */
const OPENROUTER_EMBED_BATCH_SIZE = 64;

/** Local servers document no input cap; keep requests modest for small machines. */
const LOCAL_EMBED_BATCH_SIZE = 64;

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Z.AI coding API endpoint — the primary endpoint for all GLM models. */
const GLM_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

/**
 * User-Agent the Kimi For Coding endpoint requires to recognize ggcoder as a
 * coding agent. The endpoint gates solely on this header; the version is
 * overridable via KIMI_CODE_VERSION for forward compatibility.
 */
const KIMI_CODE_USER_AGENT = `kimi-code-cli/${process.env.KIMI_CODE_VERSION ?? "1.0.11"}`;

/**
 * Grok CLI chat proxy — the endpoint a Grok subscription OAuth token is valid
 * against (gg-core's `grokCliBaseUrl()` persists it on the credential). Matched
 * by host so an env override of that base URL still gets the identity headers.
 */
const GROK_CLI_PROXY_HOST = "cli-chat-proxy.grok.com";

/**
 * Client identity the Grok CLI chat proxy requires. It hard-gates on this: with
 * no version it answers "Your Grok CLI version (none) is outdated. Please update
 * to version 0.1.202 or later", so the value must look like a real Grok CLI build
 * (they ship 0.1.x/0.2.x) rather than a placeholder. Overridable via
 * GROK_CLI_VERSION. Keep in sync with gg-core's `grokCliHeaders()`, the
 * login-side source of truth.
 */
const GROK_CLI_VERSION = process.env.GROK_CLI_VERSION ?? "0.2.101";

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
  // OpenAI API-key auth only; ChatGPT-subscription (Codex) tokens have no embeddings API.
  // OpenAI has no task/input-type parameter, so `inputType` is ignored.
  embed: (request) =>
    embedOpenAICompatible(request, {
      provider: "openai",
      baseUrl: request.baseUrl ?? "https://api.openai.com/v1",
    }),
  embedBatchSize: OPENAI_EMBED_BATCH_SIZE,
});

providerRegistry.register("gemini", {
  stream: (options) => streamGemini(options),
  // Native Gemini API with an AI Studio key — not the Code Assist OAuth endpoint above.
  embed: (request) => embedGemini(request),
  embedBatchSize: GEMINI_EMBED_BATCH_SIZE,
});

providerRegistry.register("glm", {
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? GLM_CODING_BASE_URL,
    }),
});

providerRegistry.register("moonshot", {
  stream: (options) => {
    const baseUrl = options.baseUrl ?? "https://api.moonshot.ai/v1";
    // The Kimi For Coding (OAuth) endpoint at api.kimi.com gates access to
    // recognized coding agents and 403s any request whose `User-Agent` isn't a
    // known client (verified empirically: User-Agent alone is the gate). Inject
    // it centrally here so EVERY stream — agent loop, compaction, title-gen,
    // sub-agents — passes, instead of relying on each call site to thread
    // headers. Caller-provided headers still win on collision.
    const defaultHeaders = baseUrl.includes("api.kimi.com")
      ? { "User-Agent": KIMI_CODE_USER_AGENT, ...options.defaultHeaders }
      : options.defaultHeaders;
    return streamOpenAI({ ...options, baseUrl, defaultHeaders });
  },
});

providerRegistry.register("deepseek", {
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.deepseek.com/v1",
    }),
});

providerRegistry.register("openrouter", {
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? OPENROUTER_BASE_URL,
    }),
  embed: (request) =>
    embedOpenAICompatible(request, {
      provider: "openrouter",
      baseUrl: request.baseUrl ?? OPENROUTER_BASE_URL,
      inputTypeFields: (inputType) => ({
        input_type: inputType === "query" ? "search_query" : "search_document",
      }),
    }),
  embedBatchSize: OPENROUTER_EMBED_BATCH_SIZE,
  rerank: (request) =>
    rerankCohereCompatible(request, {
      provider: "openrouter",
      baseUrl: request.baseUrl ?? OPENROUTER_BASE_URL,
    }),
});

providerRegistry.register("huggingface", {
  // Hugging Face Inference Providers router — one HF token (hf.co/settings/tokens,
  // "Make calls to Inference Providers" permission) routes to whichever hosted
  // backend serves each open model. Chat Completions-compatible; model ids are
  // Hub repo paths ("moonshotai/Kimi-K2.7-Code"), optionally with an
  // ":auto"/":fastest"/":cheapest" provider-selection suffix. Billing follows
  // each backend's per-token rates on the HF account (small free tier).
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? "https://router.huggingface.co/v1",
    }),
});

providerRegistry.register("sakana", {
  // Sakana Fugu is a multi-agent system exposed as a standard LLM through the
  // OpenAI-compatible Sakana API. We ride the Chat Completions transport (the
  // Responses API is also offered). Fugu models only accept "high"/"xhigh"
  // reasoning effort — clamped centrally in toOpenAIReasoningEffort.
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.sakana.ai/v1",
    }),
});

providerRegistry.register("xai", {
  // xAI's public API (console.x.ai key) is OpenAI-compatible — ride the Chat
  // Completions transport like Moonshot/DeepSeek. Grok reasoning models take
  // top-level `reasoning_effort` (low/medium/high), which the shared thinking
  // path already sends.
  //
  // Subscription OAuth (SuperGrok / X Premium) routes to the Grok CLI chat proxy
  // instead, which speaks the same Chat Completions wire but gates on Grok-CLI
  // client identity. Inject those headers centrally here — exactly as the Kimi
  // endpoint above — so EVERY stream (agent loop, compaction, title-gen,
  // sub-agents) is accepted rather than depending on each call site to thread
  // headers. Caller-provided headers still win on collision.
  stream: (options) => {
    const baseUrl = options.baseUrl ?? "https://api.x.ai/v1";
    const defaultHeaders = baseUrl.includes(GROK_CLI_PROXY_HOST)
      ? {
          "X-XAI-Token-Auth": "xai-grok-cli",
          "x-grok-client-version": GROK_CLI_VERSION,
          "x-grok-client-identifier": "ggcoder",
          "x-grok-model-override": options.model,
          ...options.defaultHeaders,
        }
      : options.defaultHeaders;
    return streamOpenAI({ ...options, baseUrl, defaultHeaders });
  },
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

/**
 * Local model ids are namespaced by endpoint (`local/<endpointId>/<rawId>`) so
 * the same model name served by two machines stays distinct in the registry.
 * The server only knows the raw id, so strip the routing prefix here — at the
 * one place that talks to the wire. Counterpart to gg-core's
 * `formatLocalModelId`/`parseLocalModelId`.
 */
export function localWireModelId(id: string): string {
  const match = /^local\/[^/]+\/(.+)$/.exec(id);
  return match?.[1] ?? id;
}

providerRegistry.register("local", {
  // Locally hosted OpenAI-compatible servers (Ollama, LM Studio, llama.cpp,
  // vLLM). There is no default endpoint: the baseUrl comes from the endpoint
  // credential the discovery layer wrote, so a missing one is a wiring bug, not
  // something to paper over with a guess at someone else's port.
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: requireLocalBaseUrl(options.baseUrl),
      model: localWireModelId(options.model),
      webSearch: false,
    }),
  // Every supported local server exposes OpenAI-compatible `/v1/embeddings`
  // (the model must be an embedding model). None has an input-type parameter.
  embed: (request) =>
    embedOpenAICompatible(request, {
      provider: "local",
      baseUrl: requireLocalBaseUrl(request.baseUrl),
      wireModel: localWireModelId(request.model),
    }),
  embedBatchSize: LOCAL_EMBED_BATCH_SIZE,
  // llama.cpp (`llama-server --rerank`) and vLLM serve `/v1/rerank`; Ollama and
  // LM Studio don't, and answer with a 404 ProviderError.
  rerank: (request) =>
    rerankCohereCompatible(request, {
      provider: "local",
      baseUrl: requireLocalBaseUrl(request.baseUrl),
      wireModel: localWireModelId(request.model),
    }),
});

function requireLocalBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl) {
    throw new GGAIError(
      "Local provider requires a baseUrl (e.g. http://127.0.0.1:11434/v1). " +
        "No local endpoint was resolved for this model — re-scan for local models.",
    );
  }
  return baseUrl;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Unified streaming entry point. Returns a StreamResult that is both
 * an async iterable (for streaming events) and thenable (await for
 * the final response).
 *
 * Providers are resolved via the provider registry. Built-in providers
 * (anthropic, openai, glm, moonshot) are registered at module load.
 * Extensions can register custom providers via `providerRegistry.register()`.
 * The same registry backs `embed()` and `rerank()`: a provider entry may also
 * carry `embed` / `rerank` functions (check `providerRegistry.supports(name,
 * "embed")`), and `providerOptions` passes provider-specific body fields to all
 * three.
 *
 * ```ts
 * // Stream events
 * for await (const event of stream({ provider: "anthropic", model: "claude-sonnet-5", messages })) {
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
  // Fail fast with a clean capability error when video is in the request but the
  // model can't watch it (e.g. a video read under Kimi/Gemini left in history,
  // then the user switched to a text-only model). Without this, the provider
  // rejects the video block with an opaque "invalid tag 'video'" API error.
  if (options.supportsVideo !== true && messagesContainVideo(options.messages)) {
    throw new VideoUnsupportedError();
  }
  const wireMessages = stripMessageProvenance(options.messages);
  // Unpaired surrogates (split emoji in tool args, char-indexed truncation, odd
  // shell bytes) make the JSON body unparseable for every provider — and stay in
  // history, so retries and model switches fail identically. Scrub them here,
  // the one place all providers pass through.
  //
  // Likewise a tool call whose name the target provider rejects (blank,
  // invocation text in the name slot, over the length limit) would 400 every
  // later request, so drop it and its results for this request only.
  const sanitized = sanitizeMessagesForWire(wireMessages);
  const replayable = dropInvalidToolCalls(
    sanitized,
    toolCallNameRuleFor(options.provider, {
      accountId: options.accountId,
      baseUrl: options.baseUrl,
    }),
  );
  const messages = clampProviderContextImages(replayable, options.provider, options.supportsImages);
  if (options.onContextPrepared) {
    try {
      // Image accounting is index-aligned, so observe against the post-drop
      // list (dropping a malformed call can remove whole messages).
      options.onContextPrepared(
        observePreparedContext(
          replayable === sanitized ? wireMessages : replayable,
          messages,
          options.tools ?? [],
        ),
      );
    } catch {
      // Diagnostics must not change request behaviour or expose an exception containing prompts.
    }
  }
  return entry.stream(messages === options.messages ? options : { ...options, messages });
}

/** Clone provenance-bearing messages and remove internal metadata at the provider boundary. */
function stripMessageProvenance(messages: Message[]): Message[] {
  let stripped: Message[] | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (!message.provenance) continue;
    stripped ??= messages.slice();
    const { provenance: _provenance, ...wireMessage } = message;
    stripped[index] = wireMessage as Message;
  }
  return stripped ?? messages;
}

/** True if any message carries a video block, in user content or a tool result. */
function messagesContainVideo(messages: Message[]): boolean {
  for (const msg of messages) {
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "video") return true;
      if (part.type === "tool_result" && Array.isArray(part.content)) {
        if (part.content.some((block) => block.type === "video")) return true;
      }
    }
  }
  return false;
}
