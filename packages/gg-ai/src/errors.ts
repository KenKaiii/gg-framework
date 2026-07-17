/**
 * Error model for gg-ai and downstream consumers.
 *
 * Every error users see should answer one question: "is this me or them?"
 * That answer drives whether they retry, switch model, log in, or report a
 * GG Coder bug. The `FormattedError` shape captures it in plain English:
 *
 *   ✗ OpenAI returned an error.
 *     An error occurred while processing your request...
 *     → This is an OpenAI issue, not GG Coder. Retry — if it persists, check status.openai.com.
 *
 *   ✗ GG Coder hit an unexpected error.
 *     Cannot read property 'foo' of undefined
 *     → This is a GG Coder bug — please report it.
 */

export type ErrorSource = "provider" | "ggcoder" | "network" | "auth" | "capability";

/**
 * Probe a web `Headers` object or a plain header record for the first present
 * header among `names`. Case-insensitive for plain records. Returns the value
 * of the first name that resolves to a string, or `undefined`.
 */
export function readHeader(headers: unknown, ...names: string[]): string | undefined {
  if (!headers) return undefined;
  const getter =
    typeof (headers as { get?: unknown }).get === "function"
      ? (name: string): string | undefined => (headers as Headers).get(name) ?? undefined
      : typeof headers === "object"
        ? (name: string): string | undefined => {
            const rec = headers as Record<string, unknown>;
            const value = rec[name] ?? rec[name.toLowerCase()];
            return typeof value === "string" ? value : undefined;
          }
        : undefined;
  if (!getter) return undefined;
  for (const name of names) {
    const value = getter(name);
    if (value != null) return value;
  }
  return undefined;
}

export interface FormattedError {
  /** Plain-English headline, e.g. "OpenAI returned an error." */
  headline: string;
  /** Machine-readable classification. */
  source: ErrorSource;
  /** Detailed message body from the underlying error (no JSON, no tag prefix). */
  message: string;
  /** Action line — tells the user whether to retry, switch model, log in, or report a bug. */
  guidance: string;
  /** Provider name when source === "provider". */
  provider?: string;
  /** HTTP status code if known. */
  statusCode?: number;
  /** Provider request ID, kept for telemetry / debug — not shown by default. */
  requestId?: string;
  /** Unix seconds when a usage/rate limit resets, when the provider reports it. */
  resetsAt?: number;
}

export class GGAIError extends Error {
  readonly source: ErrorSource;
  readonly requestId?: string;
  readonly hint?: string;

  constructor(
    message: string,
    options?: {
      source?: ErrorSource;
      requestId?: string;
      hint?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "GGAIError";
    this.source = options?.source ?? "ggcoder";
    this.requestId = options?.requestId;
    this.hint = options?.hint;
  }
}

/**
 * The active model can't handle some content in the request (e.g. a video block
 * left in history after switching from a video model to a text-only one). A
 * clean, user-facing capability error — not a bug, not a provider outage.
 */
export class VideoUnsupportedError extends GGAIError {
  constructor() {
    super("This model can't analyze video.", { source: "capability" });
    this.name = "VideoUnsupportedError";
  }
}

export class ProviderError extends GGAIError {
  readonly provider: string;
  readonly statusCode?: number;
  /** Unix seconds when a usage/rate limit resets, when the provider reports it. */
  readonly resetsAt?: number;

  constructor(
    provider: string,
    message: string,
    options?: {
      statusCode?: number;
      requestId?: string;
      hint?: string;
      cause?: unknown;
      resetsAt?: number;
    },
  ) {
    super(message, {
      source: "provider",
      requestId: options?.requestId,
      hint: options?.hint,
      cause: options?.cause,
    });
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = options?.statusCode;
    this.resetsAt = options?.resetsAt;
  }
}

/**
 * Display names for every provider we support. Used in headlines so users
 * see "OpenAI returned an error." rather than the slug "openai".
 */
const PROVIDER_DISPLAY: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  glm: "Z.AI (GLM)",
  moonshot: "Moonshot",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  sakana: "Sakana",
  xai: "xAI (Grok)",
  xiaomi: "Xiaomi (MiMo)",
  minimax: "MiniMax",
};

/** Status pages for providers that publish one. */
const PROVIDER_STATUS_URL: Record<string, string> = {
  openai: "status.openai.com",
  anthropic: "status.anthropic.com",
  xai: "status.x.ai",
};

function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY[provider] ?? provider;
}

/**
 * Normalise any thrown value into a structured display object. Always returns
 * a non-empty `headline` and `guidance` so the UI never has to second-guess
 * what to show the user.
 */
/**
 * Is this a subscription/plan usage-window exhaustion error (as opposed to a
 * transient per-minute throttle)? These don't clear with a quick retry — the
 * user has to wait for the window to reset — so callers must surface them as a
 * hard stop, not silently retry for minutes. Detected from the canonical
 * "usage limit reached" message gg-ai stamps onto the ProviderError.
 */
export function isUsageLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /usage limit reached/i.test(err.message);
}

/**
 * Substrings that mark a hard, non-retriable billing/quota stop on ANY provider
 * (credit exhaustion, balance too low, plan quota spent). Single source of truth
 * shared across the OpenAI-compatible and Anthropic provider boundaries and the
 * agent-loop retry classifier, so the lists can't drift. Matched case-insensitively.
 */
export function isHardBillingMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("insufficient balance") ||
    lower.includes("insufficient credits") ||
    lower.includes("more credits") ||
    lower.includes("insufficient_quota") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("quota exceeded") ||
    lower.includes("no resource package") ||
    lower.includes("recharge") ||
    lower.includes("balance is too low") ||
    lower.includes("out of credits") ||
    lower.includes("arrears") ||
    lower.includes("arrearage") ||
    lower.includes("token quota") ||
    lower.includes("exceeded_current_quota_error") ||
    lower.includes("check your account balance") ||
    lower.includes("does not yet include access") ||
    lower.includes("subscription plan") ||
    lower.includes("billing")
  );
}

/** Format a unix-seconds reset timestamp for display, e.g. "3:45 PM". */
function formatResetTime(resetsAt: number): string {
  const when = new Date(resetsAt * 1000);
  const sameDay = when.toDateString() === new Date().toDateString();
  return sameDay
    ? when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : when.toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      });
}

/**
 * Anthropic's Claude Mythos models are invitation-only (Project Glasswing) —
 * unapproved accounts get a bare `not_found_error` from the API. Detect that
 * case so we can explain the access model instead of echoing the raw error.
 */
function isMythosAccessError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("mythos") &&
    (lower.includes("not_found") || lower.includes("not found") || lower.includes("no access"))
  );
}

/**
 * The OpenAI and Anthropic SDKs both build `err.message` by JSON-stringifying
 * the raw error body whenever it has no usable string `message` field (e.g.
 * `{"code":"400","message":"","param":"","type":""}` from a provider that
 * returned an empty/malformed error) — producing an unreadable blob like
 * `400 {"code":"400","message":"","param":"","type":""}`. Detect that shape so
 * provider wrappers can swap in a clean, honest fallback instead of echoing raw
 * JSON at the user. The original is never lost — it survives on `err.cause` for
 * anyone who needs to inspect the raw provider response.
 */
export function isRawJsonErrorEcho(message: string): boolean {
  const trimmed = message.trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart === -1) return false;
  // The SDKs only ever prefix the JSON with "<status> " or nothing at all.
  const prefix = trimmed.slice(0, jsonStart).trim();
  if (prefix && !/^\d+$/.test(prefix)) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(jsonStart));
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Detect a raw HTML document returned by a provider edge, proxy, or status page.
 * SDKs preserve non-JSON response bodies in `err.message`, sometimes prefixed by
 * the HTTP status. HTML is diagnostic transport debris, not a user-facing error.
 */
export function isRawHtmlErrorEcho(message: string): boolean {
  const withoutStatus = message
    .trimStart()
    .replace(/^\d{3}\s+/, "")
    .trimStart();
  return /^<!doctype\s+html(?:\s|>)/i.test(withoutStatus) || /^<html(?:\s|>)/i.test(withoutStatus);
}

/** Clean fallback when an API endpoint returned an HTML page instead of API JSON. */
export function providerHtmlErrorMessage(statusCode: number | undefined): string {
  return statusCode
    ? `The provider returned an HTML error page (HTTP ${statusCode}) instead of an API response.`
    : "The provider returned an HTML error page instead of an API response.";
}

/** Clean fallback message when a provider's error body carried no usable text. */
export function emptyProviderErrorMessage(statusCode: number | undefined): string {
  return statusCode
    ? `The provider returned an empty error response (HTTP ${statusCode}), with no further detail.`
    : "The provider returned an empty error response, with no further detail.";
}

export function formatError(err: unknown): FormattedError {
  if (err instanceof ProviderError) {
    const name = providerDisplayName(err.provider);
    const cleanMessage = cleanProviderMessage(err.message, err.statusCode);
    if (isMythosAccessError(cleanMessage)) {
      return {
        headline: "Claude Mythos 5 is invitation-only.",
        source: "provider",
        message:
          "Your Anthropic account isn't approved for Project Glasswing, so the API reports the model as not found.",
        provider: err.provider,
        statusCode: err.statusCode,
        ...(err.requestId ? { requestId: err.requestId } : {}),
        guidance:
          "Request access via your Anthropic account team (see platform.claude.com/docs/en/about-claude/models/overview), or switch to Claude Fable 5 via the model selector — same underlying model, generally available.",
      };
    }
    if (isUsageLimitError(err)) {
      const resetClause = err.resetsAt ? ` It resets at ${formatResetTime(err.resetsAt)}.` : "";
      return {
        headline: `${name} usage limit reached.`,
        source: "provider",
        message: `Your ${name} usage is finished.${resetClause}`,
        provider: err.provider,
        statusCode: err.statusCode,
        ...(err.requestId ? { requestId: err.requestId } : {}),
        ...(err.resetsAt ? { resetsAt: err.resetsAt } : {}),
        guidance: "Try again once it's back. Your conversation is preserved.",
      };
    }
    return {
      headline: `${name} returned an error.`,
      source: "provider",
      message: cleanMessage,
      provider: err.provider,
      statusCode: err.statusCode,
      requestId: err.requestId,
      guidance: err.hint ?? providerGuidance(err.provider, cleanMessage, err.statusCode),
    };
  }

  if (err instanceof GGAIError) {
    return finaliseBySource(err.source, err.message, err.requestId, err.hint);
  }

  if (err instanceof Error) {
    const source = inferSource(err);
    return finaliseBySource(source, err.message, undefined, undefined);
  }

  return finaliseBySource("ggcoder", String(err), undefined, undefined);
}

function finaliseBySource(
  source: ErrorSource,
  message: string,
  requestId: string | undefined,
  hint: string | undefined,
): FormattedError {
  switch (source) {
    case "network":
      return {
        headline: "Network error — couldn't reach the provider.",
        source,
        message,
        guidance: hint ?? "Check your internet connection. Not a GG Coder issue — retry shortly.",
        ...(requestId ? { requestId } : {}),
      };
    case "auth":
      return {
        headline: "Authentication issue.",
        source,
        message,
        guidance: hint ?? "Re-authenticate to refresh your credentials.",
        ...(requestId ? { requestId } : {}),
      };
    case "provider":
      // Provider source with no ProviderError instance — best effort.
      return {
        headline: "Provider returned an error.",
        source,
        message,
        guidance: hint ?? providerGuidance(undefined, message, undefined),
        ...(requestId ? { requestId } : {}),
      };
    case "capability":
      return {
        headline: message,
        source,
        message: "",
        guidance:
          hint ??
          "Only Kimi, Gemini, MiniMax, and MiMo-V2.5 can analyze video. Switch to one of those via the model selector.",
        ...(requestId ? { requestId } : {}),
      };
    case "ggcoder":
      return {
        headline: "GG Coder hit an unexpected error.",
        source,
        message,
        guidance:
          hint ?? "This looks like a GG Coder bug — please report it to the developer (see /help).",
        ...(requestId ? { requestId } : {}),
      };
  }
}

/**
 * Render a FormattedError as a multi-line string for terminal display.
 *
 * Format:
 *   <headline>
 *     <message>
 *     → <guidance>
 */
export function formatErrorForDisplay(err: unknown): string {
  const f = formatError(err);
  const lines = [f.headline];
  if (f.message && f.message !== f.headline) lines.push(`  ${f.message}`);
  lines.push(`  → ${f.guidance}`);
  return lines.join("\n");
}

/**
 * Strip legacy `[provider]` / `[provider:name]` prefix from a message body,
 * so older ProviderError messages render cleanly under the new headline
 * system without doubling up.
 */
function cleanProviderMessage(message: string, statusCode?: number): string {
  const clean = message.replace(/^\[[^\]]+\]\s*/, "").trim();
  return isRawHtmlErrorEcho(clean) ? providerHtmlErrorMessage(statusCode) : clean;
}

function inferSource(err: Error): ErrorSource {
  const msg = err.message.toLowerCase();
  const code = (err as { code?: string }).code ?? "";
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    msg.includes("fetch failed") ||
    msg.includes("network request failed")
  ) {
    return "network";
  }
  if (
    msg.includes("not logged in") ||
    msg.includes("token exchange failed") ||
    msg.includes("token refresh failed") ||
    msg.includes("invalid_grant")
  ) {
    return "auth";
  }
  return "ggcoder";
}

/**
 * Build the action line for a provider error: tells the user whether to
 * retry, switch model, check billing, or whether it's serious enough to
 * report. Always frames the source plainly ("This is an OpenAI issue") so
 * the user knows to NOT report it to the GG Coder dev.
 */
function providerGuidance(
  provider: string | undefined,
  message: string,
  statusCode: number | undefined,
): string {
  const name = provider ? providerDisplayName(provider) : "the provider";
  const status = provider ? PROVIDER_STATUS_URL[provider] : undefined;
  const lower = message.toLowerCase();

  if (statusCode === 401 || lower.includes("unauthorized") || lower.includes("invalid api key")) {
    return `Authentication failed with ${name}. Re-authenticate to refresh your credentials.`;
  }
  if (lower.includes("overloaded") || lower.includes("engine_overloaded")) {
    return `${name}'s servers are overloaded right now. Retry in a moment — not a GG Coder issue.`;
  }
  if (
    lower.includes("insufficient balance") ||
    lower.includes("quota exceeded") ||
    lower.includes("recharge") ||
    lower.includes("no resource package")
  ) {
    return `Your ${name} account has a billing or quota issue — check your balance. Not a GG Coder issue.`;
  }
  if (statusCode === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return `${name} rate limit hit. Wait a moment then retry — not a GG Coder issue.`;
  }
  if (statusCode === 502 || lower.includes("bad gateway")) {
    return `${name} returned a bad gateway. Retry — this is on their side, not GG Coder.`;
  }
  if (statusCode === 503 || lower.includes("service unavailable")) {
    return `${name} is temporarily unavailable. Retry shortly — not a GG Coder issue.`;
  }
  if (
    statusCode === 507 ||
    lower.includes("exceeded request buffer limit while retrying upstream")
  ) {
    return `${name}'s proxy could not retry this large request. GG Coder already retried automatically — compact the conversation, then retry.`;
  }
  if (
    statusCode === 500 ||
    lower.includes("server_error") ||
    (lower.includes("500") && lower.includes("internal server error"))
  ) {
    return status
      ? `This is an error from ${name}, not GG Coder. Retry — if it keeps happening, check ${status}.`
      : `This is an error from ${name}, not GG Coder. Retry — if it keeps happening, try a different model via the model selector.`;
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return `Request to ${name} timed out. Their servers may be slow — retry. Not a GG Coder issue.`;
  }
  if (
    lower.includes("does not recognize the requested model") ||
    (lower.includes("model") &&
      (lower.includes("not exist") || lower.includes("not found") || lower.includes("no access")))
  ) {
    return `${name} doesn't recognise this model on your account. Switch to a different model via the model selector, or check your subscription tier.`;
  }
  if (lower.includes("context_length_exceeded") || lower.includes("prompt is too long")) {
    return `Context window for this ${name} model is full. Compact the conversation to shrink history, or start a new session.`;
  }
  // Anthropic HTTP 413: the request BODY (not the token count) exceeds the
  // provider's max size. Retrying the same request fails identically — the fix
  // is to shrink history, same as a context overflow.
  if (
    statusCode === 413 ||
    lower.includes("request_too_large") ||
    lower.includes("request exceeds the maximum size")
  ) {
    return `The request to ${name} is too large. Compact the conversation to shrink history, or start a new session.`;
  }
  return status
    ? `This is an error from ${name}, not GG Coder. Retry — if it persists, check ${status}.`
    : `This is an error from ${name}, not GG Coder. Retry — if it persists, try a different model via the model selector.`;
}
