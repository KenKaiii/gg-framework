/**
 * Error model for gg-ai and downstream consumers.
 *
 * Every error users see should answer one question: "is this me or them?"
 * That answer drives whether they retry, switch model, log in, or report a
 * ggcoder bug. The `FormattedError` shape captures it in plain English:
 *
 *   ✗ OpenAI returned an error.
 *     An error occurred while processing your request...
 *     → This is an OpenAI issue, not ggcoder. Retry — if it persists, check status.openai.com.
 *
 *   ✗ ggcoder hit an unexpected error.
 *     Cannot read property 'foo' of undefined
 *     → This is a ggcoder bug — please report it.
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
  xiaomi: "Xiaomi (MiMo)",
  minimax: "MiniMax",
};

/** Status pages for providers that publish one. */
const PROVIDER_STATUS_URL: Record<string, string> = {
  openai: "status.openai.com",
  anthropic: "status.anthropic.com",
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

export function formatError(err: unknown): FormattedError {
  if (err instanceof ProviderError) {
    const name = providerDisplayName(err.provider);
    const cleanMessage = cleanProviderMessage(err.message);
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
          "Request access via your Anthropic account team (see platform.claude.com/docs/en/about-claude/models/overview), or switch to claude-fable-5 with /model — same underlying model, generally available.",
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
        guidance: hint ?? "Check your internet connection. Not a ggcoder issue — retry shortly.",
        ...(requestId ? { requestId } : {}),
      };
    case "auth":
      return {
        headline: "Authentication issue.",
        source,
        message,
        guidance: hint ?? "Run `ggcoder login` to refresh your credentials.",
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
          "Only Kimi, Gemini, MiniMax, and MiMo-V2.5 can analyze video. Switch with /model.",
        ...(requestId ? { requestId } : {}),
      };
    case "ggcoder":
      return {
        headline: "ggcoder hit an unexpected error.",
        source,
        message,
        guidance:
          hint ?? "This looks like a ggcoder bug — please report it to the developer (see /help).",
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
function cleanProviderMessage(message: string): string {
  return message.replace(/^\[[^\]]+\]\s*/, "").trim();
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
 * the user knows to NOT report it to the ggcoder dev.
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
    return `Authentication failed with ${name}. Run \`ggcoder login\` to refresh your credentials.`;
  }
  if (lower.includes("overloaded") || lower.includes("engine_overloaded")) {
    return `${name}'s servers are overloaded right now. Retry in a moment — not a ggcoder issue.`;
  }
  if (
    lower.includes("insufficient balance") ||
    lower.includes("quota exceeded") ||
    lower.includes("recharge") ||
    lower.includes("no resource package")
  ) {
    return `Your ${name} account has a billing or quota issue — check your balance. Not a ggcoder issue.`;
  }
  if (statusCode === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return `${name} rate limit hit. Wait a moment then retry — not a ggcoder issue.`;
  }
  if (statusCode === 502 || lower.includes("bad gateway")) {
    return `${name} returned a bad gateway. Retry — this is on their side, not ggcoder.`;
  }
  if (statusCode === 503 || lower.includes("service unavailable")) {
    return `${name} is temporarily unavailable. Retry shortly — not a ggcoder issue.`;
  }
  if (
    statusCode === 500 ||
    lower.includes("server_error") ||
    (lower.includes("500") && lower.includes("internal server error"))
  ) {
    return status
      ? `This is an error from ${name}, not ggcoder. Retry — if it keeps happening, check ${status}.`
      : `This is an error from ${name}, not ggcoder. Retry — if it keeps happening, try a different model with /model.`;
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return `Request to ${name} timed out. Their servers may be slow — retry. Not a ggcoder issue.`;
  }
  if (
    lower.includes("does not recognize the requested model") ||
    (lower.includes("model") &&
      (lower.includes("not exist") || lower.includes("not found") || lower.includes("no access")))
  ) {
    return `${name} doesn't recognise this model on your account. Use /model to switch, or check your subscription tier.`;
  }
  if (lower.includes("context_length_exceeded") || lower.includes("prompt is too long")) {
    return `Context window for this ${name} model is full. Run /compact to shrink history, or start a new session.`;
  }
  return status
    ? `This is an error from ${name}, not ggcoder. Retry — if it persists, check ${status}.`
    : `This is an error from ${name}, not ggcoder. Retry — if it persists, try a different model with /model.`;
}
