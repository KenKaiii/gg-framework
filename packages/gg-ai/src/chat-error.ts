import {
  formatError,
  ProviderError,
  VideoUnsupportedError,
  type ErrorDisplayOptions,
  type FormattedError,
} from "./errors.js";

/** Display meaning is separate from retry policy: a hard stop is not always a plan limit. */
export type ChatErrorReason =
  | "usage_limit"
  | "billing"
  | "quota"
  | "rate_limit"
  | "model_access"
  | "auth"
  | "network"
  | "capability"
  | "context"
  | "update"
  | "provider"
  | "unknown";

export interface FormattedChatError extends FormattedError {
  reason: ChatErrorReason;
}

function causeCode(error: unknown): string {
  if (!(error instanceof Error) || !error.cause || typeof error.cause !== "object") return "";
  const cause = error.cause;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("type" in cause && typeof cause.type === "string") return cause.type;
  return "";
}

/** Compact, factual desktop copy. Raw provider detail never becomes an executable action. */
export function formatChatError(error: unknown, display?: ErrorDisplayOptions): FormattedChatError {
  const base = formatError(error, display);
  const raw = error instanceof Error ? error.message : "";
  const code = causeCode(error);
  const text = `${code} ${raw}`.toLowerCase();
  const provider = /chatgpt/i.test(raw) ? "ChatGPT" : providerLabel(base.provider);
  const present = (
    reason: ChatErrorReason,
    headline: string,
    guidance: string,
  ): FormattedChatError => ({
    ...base,
    ...(raw ? { message: raw } : {}),
    reason,
    headline,
    guidance,
  });

  if (error instanceof VideoUnsupportedError) {
    return present(
      "capability",
      "This model can’t read this video",
      "Choose a model that supports video.",
    );
  }
  if (base.source === "capability") {
    return present(
      "unknown",
      "This request isn’t supported",
      "Open details to check the request requirements.",
    );
  }
  if (/requires a newer version of codex/.test(text)) {
    return present(
      "update",
      `${display?.productName ?? "The application"} needs an update`,
      "Update the app, or choose another model.",
    );
  }
  // Check billing and entitlement BEFORE the canonical hard-stop token stamped by adapters.
  if (
    /insufficient.*(?:balance|credits?)|(?:balance|credits?).*(?:insufficient|exhausted|depleted)|credit balance is too low|payment_required/.test(
      text,
    )
  ) {
    return present(
      "billing",
      `${provider} credits are unavailable`,
      "Check your balance and billing, or use another provider.",
    );
  }
  if (
    /usage_not_included|does not yet include access|not supported when using codex with a chatgpt account|(?:model[^\n]*(?:not found|not available|does not exist))|model_not_found/.test(
      text,
    )
  ) {
    return present(
      "model_access",
      "This model isn’t available to this account",
      "Choose another model available to your account.",
    );
  }
  if (
    /insufficient_quota|exceeded your current quota|billing.?limit|spend.?limit|quota.?exceeded/.test(
      text,
    )
  ) {
    return present(
      "quota",
      `${provider} quota is unavailable`,
      "Check your plan or billing, or use another provider.",
    );
  }
  if (/^rate_limit_exceeded$/i.test(code)) {
    return present(
      "rate_limit",
      `${provider} is limiting requests`,
      "Wait a moment before trying again.",
    );
  }
  if (/usage limit reached|usage_limit_reached/.test(text)) {
    return present(
      "usage_limit",
      `${provider} usage limit reached`,
      "Wait for the reset, or use another provider.",
    );
  }
  if (base.source === "network") {
    return present(
      "network",
      "Couldn’t reach the provider",
      "Check your connection before trying again.",
    );
  }
  if (base.source === "auth" || base.statusCode === 401) {
    return present(
      "auth",
      `${provider} sign-in needs attention`,
      "Reconnect your account in provider settings.",
    );
  }
  if (
    base.statusCode === 413 ||
    /context[_ ](?:length|window)|maximum context|request_too_large|prompt is too long/.test(text)
  ) {
    return present(
      "context",
      "This conversation is too large",
      "Compact the conversation or send a smaller request.",
    );
  }
  if (base.statusCode === 429 || /rate_limit|rate limit|too many requests/.test(text)) {
    return present(
      "rate_limit",
      `${provider} is limiting requests`,
      "Wait a moment before trying again.",
    );
  }
  if (base.statusCode === 403) {
    return present(
      "model_access",
      "This account can’t use this request",
      "Check account access or choose another model.",
    );
  }
  if (error instanceof ProviderError) {
    if (base.statusCode != null && base.statusCode >= 500) {
      return present(
        "provider",
        `${provider} couldn’t complete the request`,
        "Try again later. Check details if it keeps happening.",
      );
    }
    return present(
      "provider",
      `${provider} didn’t accept the request`,
      "Check the details before trying again.",
    );
  }
  return present("unknown", "Something went wrong", "Open details to see what was reported.");
}

function providerLabel(provider: string | undefined): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Gemini";
    case "xai":
      return "xAI";
    case "local":
      return "The local server";
    default:
      return "The provider";
  }
}
