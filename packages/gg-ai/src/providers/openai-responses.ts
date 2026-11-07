import type {
  Message,
  StreamEvent,
  StreamOptions,
  StreamResponse,
  Tool,
  ToolChoice,
} from "../types.js";
import {
  GGAIError,
  ProviderError,
  isRawHtmlErrorEcho,
  providerHtmlErrorMessage,
  readHeader,
} from "../errors.js";
import { StreamResult } from "../utils/event-stream.js";
import { providerDiag } from "../utils/diag.js";
import { mergeProviderOptions } from "../utils/provider-options.js";
import { resolveToolSchema } from "../utils/zod-to-json-schema.js";
import { makeStrictToolSchema, UnsupportedStrictSchemaError } from "../utils/strict-tool-schema.js";
import { normalizePromptCacheKey } from "./prompt-cache-key.js";
import {
  downgradeUnsupportedImages,
  downgradeUnsupportedVideos,
  toCodexReasoningEffort,
  planDeferredTools,
  supportsResponsesToolSearch,
} from "./transform.js";
import { readSseStream } from "../utils/sse.js";
import { providerFetch } from "../utils/provider-fetch.js";
import { extractRequestIdFromMessage } from "../utils/request-id.js";
import { GG_CODER_USER_AGENT } from "../user-agent.js";
import {
  consumeResponsesEvents,
  isEncryptedReasoning,
  toResponsesInput,
} from "./responses-stream.js";

/**
 * OpenAI's public Responses API, for both ways of connecting: an OpenAI API key,
 * and the ChatGPT plan through Sign in with ChatGPT (a credential with an
 * `accountId`). The plan route is a preview with its own limits
 * (developers.openai.com/siwc/token-sharing-open-source/preview-limitations):
 * `store:false` + `stream:true`, tools grouped in a namespace, no hosted
 * `tool_search`, and no temperature / max_output_tokens / prompt_cache_retention.
 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** Namespace the plan route groups GG Coder's function tools under. */
export const CHATGPT_PLAN_TOOL_NAMESPACE = "gg";
const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/**
 * GPT-6 family (and gpt-5.6): reasoning can't be turned off, and the models
 * default to low verbosity. Point releases keep the dotted version (gpt-6.1-sol).
 */
export function usesResponsesLite(model: string): boolean {
  return model.startsWith("gpt-5.6-") || model.startsWith("gpt-6-") || model.startsWith("gpt-6.");
}

/** True when `options` reach the ChatGPT plan route rather than an API key. */
export function isChatGPTPlanRoute(options: { accountId?: string }): boolean {
  return Boolean(options.accountId);
}

function toResponsesToolChoice(choice: ToolChoice | undefined, tools: Tool[] | undefined): string {
  const resolved = choice ?? "auto";
  if (typeof resolved === "object") {
    throw new GGAIError(
      `OpenAI Responses does not support selecting the named tool \`${resolved.name}\`; use auto, none, or required.`,
      { source: "capability" },
    );
  }
  if (resolved === "required" && !tools?.length) {
    throw new GGAIError("OpenAI cannot require a tool call when no tools are configured.", {
      source: "capability",
    });
  }
  return resolved;
}

export function streamOpenAIResponses(options: StreamOptions): StreamResult {
  return new StreamResult(runStream(options), options.signal);
}

async function* runStream(
  options: StreamOptions,
  retriedWithoutReasoning = false,
): AsyncGenerator<StreamEvent, StreamResponse> {
  const plan = isChatGPTPlanRoute(options);
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/responses`;

  const downgradedImages = downgradeUnsupportedImages(options.messages, options.supportsImages);
  // The Responses API takes no video input.
  const downgraded = downgradeUnsupportedVideos(downgradedImages, options.supportsVideo);
  // Client tool search (GPT-5.4+, API keys only — the plan route rejects
  // `tool_search`): a promoted tool is loaded by a tool_search_output in the
  // transcript instead of growing `tools`, which would miss the cached prefix.
  const deferredPlan =
    !plan && supportsResponsesToolSearch(options.model)
      ? planDeferredTools(options.tools, options.deferredTools, downgraded)
      : undefined;
  const strictTools = options.strictTools ?? true;
  const toolSearchLoads = deferredPlan
    ? new Map(
        [...deferredPlan.loaded].map((name) => {
          const tool = deferredPlan.byName.get(name);
          const [wire] = tool ? toResponsesTools([tool], strictTools) : [];
          return [name, { ...(wire as Record<string, unknown>), defer_loading: true }] as const;
        }),
      )
    : undefined;
  const liveTools = deferredPlan?.live ?? options.tools;
  const { system, input } = toResponsesInput(downgraded, {
    supportsImages: options.supportsImages,
    toolSearchLoads,
    mapId: remapCallId,
    ...(plan ? { toolNamespace: CHATGPT_PLAN_TOOL_NAMESPACE } : {}),
    // Stamped reasoning belongs to another transport (e.g. Grok's) and would
    // be rejected here; OpenAI's own items are never stamped.
    keepReasoning: (part) => part.origin === undefined,
  });

  const gpt6 = usesResponsesLite(options.model);
  const body: Record<string, unknown> = {
    model: options.model,
    store: false,
    stream: true,
    instructions: system,
    input,
    tool_choice: toResponsesToolChoice(options.toolChoice, liveTools),
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
  };

  if (liveTools?.length) {
    const wire = toResponsesTools(liveTools, strictTools);
    body.tools = plan
      ? [
          {
            type: "namespace",
            name: CHATGPT_PLAN_TOOL_NAMESPACE,
            description: "GG Coder's tools for working in the user's project.",
            tools: wire,
          },
        ]
      : wire;
  }
  // A prompt_cache_key routes requests with the same prefix to the same cache
  // shard, so shared system+tool prefixes across sub-agents hit reliably.
  body.prompt_cache_key = normalizePromptCacheKey(options.promptCacheKey ?? "ggcoder");
  if (!plan && options.temperature != null && !options.thinking) {
    body.temperature = options.temperature;
  }
  // Fast mode is the `priority` service tier.
  if (options.speed === "fast") {
    body.service_tier = "priority";
  }
  body.reasoning = {
    // GPT-5.6/6 require at least low; older models still support thinking off.
    // `ultra` is a client orchestration preset, not an API effort.
    effort: options.thinking
      ? toCodexReasoningEffort(options.thinking, options.model)
      : gpt6
        ? "low"
        : "none",
    summary: "auto",
  };
  // GPT-6 models default to low verbosity; omitting it produces much longer
  // outputs — slower turns and heavier usage on the deep-reasoning models.
  if (gpt6) {
    body.text = { verbosity: "low" };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${options.apiKey}`,
    "User-Agent": GG_CODER_USER_AGENT,
  };

  const json = JSON.stringify(mergeProviderOptions(body, options.providerOptions));
  providerDiag("openai_responses_request_body", { rawBytes: json.length, plan });

  const response = await providerFetch(url, {
    method: "POST",
    headers,
    body: json,
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const parsed = parseErrorBody(text, response.status);
    const message = parsed.message ?? `OpenAI returned HTTP ${response.status}.`;
    const requestId =
      parsed.requestId ??
      readHeader(response.headers, "x-request-id", "openai-request-id", "x-oai-request-id");

    // A rejected encrypted replay item poisons every ordinary retry. Retry once
    // with visible conversation/tool history only, before any output is emitted.
    // Never alter saved messages or bypass server verification of an opaque blob.
    if (
      !retriedWithoutReasoning &&
      !options.signal?.aborted &&
      response.status === 400 &&
      (parsed.errorObj?.code === "invalid_encrypted_content" ||
        /encrypted content.*could not be (?:verified|decrypted|parsed)/i.test(message)) &&
      options.messages.some(
        (msg) =>
          msg.role === "assistant" &&
          Array.isArray(msg.content) &&
          msg.content.some((part) => part.type === "raw" && isEncryptedReasoning(part.data)),
      )
    ) {
      providerDiag("openai_responses_retry_without_encrypted_reasoning", {
        status: response.status,
      });
      const messages = options.messages.map((msg): Message =>
        msg.role === "assistant" && Array.isArray(msg.content)
          ? {
              ...msg,
              content: msg.content.filter(
                (part) => !(part.type === "raw" && isEncryptedReasoning(part.data)),
              ),
            }
          : msg,
      );
      return yield* runStream({ ...options, messages }, true);
    }

    if (plan) {
      const planError = chatGPTPlanError(
        parsed.errorObj,
        response.status,
        requestId,
        message,
        options.model,
      );
      if (planError) throw planError;
    }

    let hint: string | undefined;
    if (response.status === 404 && text.includes("does not exist")) {
      hint = plan
        ? "This model isn't available on your ChatGPT plan. Choose another model using the model selector."
        : "This model isn't available to your OpenAI API key. Choose another model using the model selector.";
    }

    throw new ProviderError("openai", message, {
      statusCode: response.status,
      ...(requestId ? { requestId } : {}),
      ...(hint ? { hint } : {}),
    });
  }

  if (!response.body) {
    throw new ProviderError("openai", "No response body from OpenAI");
  }

  return yield* consumeResponsesEvents(parseSSE(response.body), {
    provider: "openai",
    label: "OpenAI",
    diagPrefix: "openai_responses",
    thinking: !!options.thinking,
    errorChunk: (errorObj, requestId) =>
      plan ? chatGPTPlanError(errorObj, undefined, requestId, undefined, options.model) : null,
  });
}

// ── SSE Parser ─────────────────────────────────────────────

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  for await (const event of readSseStream(body)) {
    const data = event.data.trim();
    if (!data || data === "[DONE]") continue;
    try {
      yield JSON.parse(data) as Record<string, unknown>;
    } catch {
      // skip malformed JSON
    }
  }
}

// ── Message Conversion ─────────────────────────────────────

/**
 * Remap tool call IDs to the Responses API's stricter ID grammar: function-call
 * IDs start with `fc_`/`fc-` and contain only letters, numbers, underscores, or
 * dashes. Continued sessions can contain IDs from other transports/tools such
 * as `toolu_*` or `fc_tasks:153`.
 */
function remapCallId(id: string, idMap: Map<string, string>): string {
  const existing = idMap.get(id);
  if (existing) return existing;

  const withPrefix =
    id.startsWith("fc_") || id.startsWith("fc-") ? id : `fc_${id.replace(/^toolu_/, "")}`;
  const sanitized = withPrefix.replace(/[^A-Za-z0-9_-]/g, "_");
  let mapped = sanitized;
  let suffix = 2;
  const used = new Set(idMap.values());
  while (used.has(mapped)) {
    mapped = `${sanitized}_${suffix++}`;
  }
  idMap.set(id, mapped);
  return mapped;
}

// ── Tool Conversion ────────────────────────────────────────

function toResponsesTools(tools: Tool[], strictTools: boolean): unknown[] {
  return tools.map((tool) => {
    let parameters = resolveToolSchema(tool);
    let strict: true | null = null;
    if (strictTools) {
      try {
        parameters = makeStrictToolSchema(parameters);
        strict = true;
      } catch (error) {
        if (!(error instanceof UnsupportedStrictSchemaError)) throw error;
      }
    }
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters,
      strict,
    };
  });
}

// HTTP error bodies may be JSON, useful plain text, or an HTML edge/proxy page.
// Extract a bounded message plus request ID while keeping raw JSON and markup out
// of every user-facing error path.
function parseErrorBody(
  text: string,
  statusCode: number,
): {
  message?: string;
  requestId?: string;
  errorObj?: Record<string, unknown>;
} {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    const detail = parsed.detail as unknown;
    const rawMessage =
      (error?.message as string | undefined) ??
      (parsed.message as string | undefined) ??
      (typeof detail === "string" ? detail : undefined);
    const message =
      rawMessage && isRawHtmlErrorEcho(rawMessage)
        ? providerHtmlErrorMessage(statusCode)
        : rawMessage;
    const requestId =
      (parsed.request_id as string | undefined) ??
      (error?.request_id as string | undefined) ??
      (message ? extractRequestIdFromMessage(message) : undefined);
    // Direct-route admission errors can be `{"detail": "..."}` with no
    // `error` object — fall back to the whole payload.
    const errorObj = error ?? parsed;
    return {
      ...(message ? { message } : {}),
      ...(requestId ? { requestId } : {}),
      ...(errorObj ? { errorObj } : {}),
    };
  } catch {
    const trimmed = text.trim();
    if (isRawHtmlErrorEcho(trimmed)) {
      return { message: providerHtmlErrorMessage(statusCode) };
    }
    // Preserve useful plain-text errors, capped to keep accidental proxy output bounded.
    const bounded = trimmed.slice(0, 240);
    return bounded ? { message: bounded } : {};
  }
}

/**
 * Map a ChatGPT plan route error to a clear ProviderError, or null for anything
 * without a specific recovery (it then flows through the normal error path).
 * Codes: developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 */
export function chatGPTPlanError(
  errorObj: Record<string, unknown> | undefined,
  statusCode: number | undefined,
  requestId: string | undefined,
  message: string | undefined,
  model?: string,
): ProviderError | null {
  const code = String(errorObj?.code ?? errorObj?.type ?? "");
  const base = { ...(requestId ? { requestId } : {}), cause: errorObj };
  switch (code) {
    // The plan's usage — or the limit the user set for GG Coder — is spent, or
    // can't be checked right now. Both stop plan requests; the canonical
    // "usage limit reached" message lets the session fall back to an API key.
    case "subscription_sharing_usage_limit_exceeded":
    case "subscription_sharing_usage_unavailable":
      return new ProviderError("openai", "ChatGPT usage limit reached", {
        ...base,
        statusCode: statusCode ?? (code.endsWith("unavailable") ? 503 : 429),
        hint:
          code === "subscription_sharing_usage_unavailable"
            ? "OpenAI couldn't check your ChatGPT plan usage just now. Try again shortly, or add an OpenAI API key to keep going."
            : `Check or raise what GG Coder may use at ${CHATGPT_USAGE_URL}, or add an OpenAI API key to keep going.`,
      });
    case "subscription_sharing_user_not_eligible":
      return new ProviderError(
        "openai",
        "ChatGPT plan use isn't available for this account or workspace.",
        {
          ...base,
          statusCode: statusCode ?? 403,
          hint: "Add an OpenAI API key, or ask your workspace admin to allow ChatGPT plan use in other apps.",
        },
      );
    // The account's plan doesn't include this model (live: 400 model_not_found,
    // "…not supported when using Codex with a ChatGPT account").
    case "model_not_found":
      return new ProviderError(
        "openai",
        `${model ?? "This model"} isn't included in your ChatGPT plan.`,
        {
          ...base,
          statusCode: statusCode ?? 400,
          hint: "Pick a model your plan includes (the model picker marks the others), or use an OpenAI API key for this one.",
        },
      );
    case "subscription_sharing_unsupported_capability": {
      const param = typeof errorObj?.param === "string" ? errorObj.param : undefined;
      if (param?.includes("service_tier")) {
        return new ProviderError("openai", "Fast mode isn't included in your ChatGPT plan.", {
          ...base,
          statusCode: statusCode ?? 400,
          hint: "Switch to the standard model, or use an OpenAI API key for Fast mode.",
        });
      }
      return new ProviderError(
        "openai",
        message ?? `The ChatGPT plan route doesn't support ${param ?? "part of this request"}.`,
        {
          ...base,
          statusCode: statusCode ?? 400,
          hint: `${param ? `\`${param}\` isn't` : "Part of this request isn't"} available on the ChatGPT plan. Choose another model, or add an OpenAI API key.`,
        },
      );
    }
    case "subscription_sharing_invalid_user":
      return new ProviderError("openai", message ?? "ChatGPT couldn't validate your sign-in.", {
        ...base,
        statusCode: statusCode ?? 401,
        hint: "Continue with ChatGPT again to reconnect.",
      });
    default:
      return null;
  }
}
