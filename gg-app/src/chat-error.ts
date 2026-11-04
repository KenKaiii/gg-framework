export const CHAT_ERROR_REASONS = [
  "usage_limit",
  "billing",
  "quota",
  "rate_limit",
  "model_access",
  "auth",
  "network",
  "capability",
  "context",
  "update",
  "provider",
  "unknown",
] as const;
export type ChatErrorReason = (typeof CHAT_ERROR_REASONS)[number];

export interface ChatErrorData {
  text?: string;
  headline?: string;
  message?: string;
  guidance?: string;
  reason?: ChatErrorReason;
  scope?: string;
  source?: string;
  provider?: string;
  statusCode?: number;
  requestId?: string;
  /** Unix milliseconds. */
  occurredAt?: number;
  /** Provider wire format is Unix seconds, not the usage meter's milliseconds. */
  resetsAt?: number;
  historical?: boolean;
}
export type ChatErrorItem = ChatErrorData & { kind: "error"; id: number };

function text(value: unknown, limit = 8_000): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, limit) : undefined;
}
function timestamp(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000
    ? value
    : undefined;
}
function reason(value: unknown): ChatErrorReason | undefined {
  return CHAT_ERROR_REASONS.find((candidate) => candidate === value);
}

/** Validate additive SSE/history fields, while still accepting older sidecars. */
export function readChatError(
  value: Readonly<Record<string, unknown>>,
  scope = "error",
  historical = false,
): ChatErrorData {
  const headline = text(value.headline, 1_000);
  const prefix =
    scope === "ken_error" ? "Helper: " : scope === "autopilot_error" ? "Autopilot: " : "";
  return {
    scope,
    historical,
    headline: headline
      ? `${prefix}${headline.startsWith(prefix) ? headline.slice(prefix.length) : headline}`
      : undefined,
    message: text(value.message),
    text: text(value.text) ?? (!headline ? text(value.message) : undefined),
    guidance: text(value.guidance),
    reason: reason(value.reason),
    source: text(value.source, 40),
    provider: text(value.provider, 80),
    requestId: text(value.requestId, 300),
    occurredAt: timestamp(value.occurredAt),
    resetsAt: timestamp(value.resetsAt),
    statusCode:
      typeof value.statusCode === "number" &&
      Number.isInteger(value.statusCode) &&
      value.statusCode >= 100 &&
      value.statusCode <= 599
        ? value.statusCode
        : undefined,
  };
}

/** One reverse scan, not one scan per error. Only a new user attempt retires the latest error. */
export function activeChatErrorId(
  items: readonly { id: number; kind: string; historical?: boolean }[],
): number | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === "user") return null;
    if (item.kind === "error") return item.historical ? null : item.id;
  }
  return null;
}

export function chatErrorTone(
  error: ChatErrorData,
  active: boolean,
): "error" | "warning" | "history" {
  if (!active || error.historical) return "history";
  if (error.scope === "interrupted_run") return "warning";
  return error.reason &&
    [
      "usage_limit",
      "quota",
      "rate_limit",
      "model_access",
      "auth",
      "capability",
      "context",
      "update",
    ].includes(error.reason)
    ? "warning"
    : "error";
}

export function chatErrorCopy(
  error: ChatErrorData,
  active: boolean,
  now: number,
): {
  headline: string;
  guidance: string;
  resetLabel?: string;
} {
  const scope =
    error.scope === "ken_error"
      ? "Helper: "
      : error.scope === "autopilot_error"
        ? "Autopilot: "
        : "";
  const originalHeadline = error.headline ?? "Something went wrong";
  const headline =
    scope && originalHeadline.startsWith(scope)
      ? originalHeadline.slice(scope.length)
      : originalHeadline;
  if (!active || error.historical) {
    return {
      headline: `${scope}Earlier: ${headline}`,
      guidance: "From a previous attempt. Open details for the original report.",
    };
  }
  const known = error.reason || error.scope === "interrupted_run";
  const guidance = known
    ? (error.guidance ?? "Open details to see what was reported.")
    : "Open details to see what was reported.";
  const title = `${scope}${known ? headline : "Something went wrong"}`;
  if (error.reason !== "usage_limit" || error.resetsAt == null)
    return { headline: title, guidance };
  const resetMs = error.resetsAt * 1000;
  if (resetMs <= now)
    return {
      headline: title,
      guidance: "The reset time has passed. Check usage before trying again.",
    };
  const reset = new Date(resetMs);
  return Number.isFinite(reset.getTime())
    ? { headline: title, guidance, resetLabel: `Reported reset: ${reset.toLocaleString()}` }
    : { headline: title, guidance };
}
