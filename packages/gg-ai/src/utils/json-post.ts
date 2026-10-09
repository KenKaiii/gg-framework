import {
  GGAIError,
  ProviderError,
  emptyProviderErrorMessage,
  isHardBillingMessage,
  isRawHtmlErrorEcho,
  providerHtmlErrorMessage,
  readHeader,
} from "../errors.js";
import { redactText } from "../redaction.js";

/** Longest provider error text kept on an error message (matches the Codex transport). */
const MAX_ERROR_MESSAGE_CHARS = 240;

export interface JsonPostRequest {
  /** Provider name used for `ProviderError.provider`. */
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** Credential values that must never appear in an error message. */
  secrets?: readonly (string | undefined)[];
}

export interface JsonPostResponse {
  json: unknown;
  requestId?: string;
}

export function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/**
 * POST a JSON body and parse the JSON reply, mapping every failure onto
 * gg-ai's error model:
 *
 * - abort → `DOMException("Aborted", "AbortError")`, as `stream()` does
 * - fetch rejection → `GGAIError` with source `"network"`
 * - HTTP 401/403 → `ProviderError` with source `"auth"`
 * - HTTP 402 / insufficient quota / hard billing text → `ProviderError` stamped
 *   "usage limit reached" (so `isUsageLimitError` sees it as a hard stop)
 * - HTTP 429 → `ProviderError` with `resetsAt` from `Retry-After` when present
 * - anything else → `ProviderError` with status code and request id
 *
 * Error bodies are reduced to their message, redacted and truncated. No retries:
 * like `stream()`, retry policy belongs to the caller.
 */
export async function postJson(request: JsonPostRequest): Promise<JsonPostResponse> {
  const { provider, signal } = request;
  const secrets = request.secrets?.filter((s): s is string => typeof s === "string" && s !== "");
  const clean = (text: string): string => bound(redactText(text, { secrets }));
  const fetchImpl = request.fetch ?? globalThis.fetch;

  throwIfAborted(signal);
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw abortError();
    const detail = err instanceof Error ? err.message : String(err);
    throw new GGAIError(`Couldn't reach ${provider}: ${clean(detail)}`, {
      source: "network",
      cause: err,
    });
  }

  const headerRequestId = readHeader(
    response.headers,
    "x-request-id",
    "request-id",
    "openai-request-id",
  );

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw abortError();
    throw new GGAIError(`Lost the connection to ${provider} while reading its response.`, {
      source: "network",
      cause: err,
    });
  }

  if (!response.ok) {
    throw httpError(provider, response, text, headerRequestId, clean);
  }

  try {
    return {
      json: JSON.parse(text) as unknown,
      ...(headerRequestId ? { requestId: headerRequestId } : {}),
    };
  } catch {
    throw new ProviderError(provider, `${provider} returned a response that isn't valid JSON.`, {
      statusCode: response.status,
      ...(headerRequestId ? { requestId: headerRequestId } : {}),
    });
  }
}

function httpError(
  provider: string,
  response: Response,
  text: string,
  headerRequestId: string | undefined,
  clean: (text: string) => string,
): ProviderError {
  const status = response.status;
  const parsed = parseErrorBody(text);
  // A JSON body with no recognisable message is noise, not something to show.
  const rawMessage = parsed.message ?? (parsed.isJson ? "" : text.trim());
  const message = !rawMessage
    ? emptyProviderErrorMessage(status)
    : isRawHtmlErrorEcho(rawMessage)
      ? providerHtmlErrorMessage(status)
      : clean(rawMessage);
  const requestId = headerRequestId ?? parsed.requestId;
  const base = {
    statusCode: status,
    ...(requestId ? { requestId } : {}),
  };

  if (status === 401 || status === 403) {
    return new ProviderError(provider, message, { ...base, source: "auth" });
  }

  const codeType = `${parsed.code ?? ""} ${parsed.type ?? ""}`.toLowerCase();
  if (status === 402 || codeType.includes("insufficient_quota") || isHardBillingMessage(message)) {
    const stamped = /usage limit reached/i.test(message)
      ? message
      : `usage limit reached: ${message}`;
    return new ProviderError(provider, stamped, base);
  }

  if (status === 429) {
    const retryAfter = Number(readHeader(response.headers, "retry-after"));
    const resetsAt =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.floor(Date.now() / 1000) + Math.ceil(retryAfter)
        : undefined;
    return new ProviderError(provider, message, {
      ...base,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }

  return new ProviderError(provider, message, base);
}

interface ParsedErrorBody {
  isJson: boolean;
  message?: string;
  requestId?: string;
  code?: string;
  type?: string;
}

/** Pull the human message out of the common `{ error: { message } }` / `{ message }` / `{ detail }` shapes. */
function parseErrorBody(text: string): ParsedErrorBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { isJson: false };
  }
  if (!isRecord(parsed)) return { isJson: true };
  const error = parsed.error;
  const errorObj = isRecord(error) ? error : undefined;
  const message =
    stringField(errorObj, "message") ??
    (typeof error === "string" && error.trim() ? error.trim() : undefined) ??
    stringField(parsed, "message") ??
    stringField(parsed, "detail");
  const requestId = stringField(parsed, "request_id") ?? stringField(errorObj, "request_id");
  const code = stringField(errorObj, "code") ?? stringField(errorObj, "status");
  const type = stringField(errorObj, "type");
  return {
    isJson: true,
    ...(message ? { message } : {}),
    ...(requestId ? { requestId } : {}),
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
  };
}

function stringField(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error || err instanceof DOMException) &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

function bound(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_ERROR_MESSAGE_CHARS
    ? `${trimmed.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : trimmed;
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
