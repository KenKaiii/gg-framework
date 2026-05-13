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

export type ErrorSource = "provider" | "ggcoder" | "network" | "auth";

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

export class ProviderError extends GGAIError {
  readonly provider: string;
  readonly statusCode?: number;

  constructor(
    provider: string,
    message: string,
    options?: {
      statusCode?: number;
      requestId?: string;
      hint?: string;
      cause?: unknown;
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
  }
}

/**
 * Display names for every provider we support. Used in headlines so users
 * see "OpenAI returned an error." rather than the slug "openai".
 */
const PROVIDER_DISPLAY: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  glm: "Z.AI (GLM)",
  moonshot: "Moonshot",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
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
export function formatError(err: unknown): FormattedError {
  if (err instanceof ProviderError) {
    const name = providerDisplayName(err.provider);
    const cleanMessage = cleanProviderMessage(err.message);
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
