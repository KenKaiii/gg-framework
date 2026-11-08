import type { Provider } from "./types.js";

/**
 * Fast-mode model ids: `<base model id>` + this suffix selects the same model
 * at its provider's faster speed tier. The suffixed id is a registry/UI concept
 * only — `stream()` rewrites it to the base id plus `speed: "fast"` before any
 * provider sees it, so every model-id check downstream still matches.
 */
export const FAST_MODE_SUFFIX = "-fast";

/**
 * Base models that accept a fast speed tier, per provider:
 *  - Anthropic: `speed: "fast"` + `fast-mode-2026-02-01` beta. Opus 5.5 is the
 *    only supported model we register (Sonnet/Haiku/Fable reject it). On a
 *    Claude subscription it bills usage credits, never included plan usage.
 *  - OpenAI: `service_tier: "priority"` (what the Codex CLI sends for Fast mode;
 *    the ChatGPT backend rejects the literal "fast"). Every model listed here
 *    advertises the priority tier in openai/codex models.json; on a ChatGPT
 *    plan it draws included limits at 2.5x the standard rate.
 */
const FAST_MODE_BASE_MODELS: Readonly<Partial<Record<Provider, readonly string[]>>> = {
  anthropic: ["claude-opus-5-5"],
  openai: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"],
};

export interface FastModeResolution {
  /** The real model id to send on the wire. */
  model: string;
  /** True when the id selected a fast speed tier. */
  fast: boolean;
}

/**
 * Split a fast-mode model id into its base model. Ids without the suffix, or
 * whose base doesn't support fast mode for `provider`, pass through unchanged.
 */
export function resolveFastModeModel(provider: Provider, model: string): FastModeResolution {
  if (!model.endsWith(FAST_MODE_SUFFIX)) return { model, fast: false };
  const base = model.slice(0, -FAST_MODE_SUFFIX.length);
  return FAST_MODE_BASE_MODELS[provider]?.includes(base)
    ? { model: base, fast: true }
    : { model, fast: false };
}

// ── Anthropic fast-mode rejections ─────────────────────────
//
// On a Claude subscription, fast mode bills usage credits only. When it can't,
// Anthropic answers HTTP 429 with the same generic body ("Usage credits are
// required for fast mode.") whatever the cause, plus the real reason in the
// `anthropic-ratelimit-unified-overage-disabled-reason` header (verified live:
// `out_of_credits`). The reason codes and their meanings mirror Claude Code's
// own mapping (claude-code 2.1.288). None of them clear by waiting.

/** Header carrying why usage credits couldn't pay for a fast-mode request. */
export const FAST_MODE_REJECTION_HEADER = "anthropic-ratelimit-unified-overage-disabled-reason";

/** Canonical message prefix gg-ai stamps on fast-mode rejections; matched downstream. */
const FAST_MODE_REJECTION_PREFIX = "Fast mode unavailable";

const USAGE_PAGE = "claude.ai/settings/usage";
const STANDARD_SPEED_FALLBACK =
  "or switch to Claude Opus 5.5 (standard speed), which uses your plan";

export interface FastModeRejection {
  /** Anthropic's reason code (`unknown` when it sent none). */
  reason: string;
  /** Short, factual headline for the error card. */
  headline: string;
  /** What the user can do about it. */
  guidance: string;
  /** "billing": credits ran out or hit a cap. "access": credits are off or not offered. */
  kind: "billing" | "access";
}

/** Describe a fast-mode rejection reason in user terms. */
export function describeFastModeRejection(reason: string | undefined): FastModeRejection {
  const code = reason?.trim() || "unknown";
  const of = (
    headline: string,
    guidance: string,
    kind: FastModeRejection["kind"],
  ): FastModeRejection => ({ reason: code, headline, guidance, kind });
  switch (code) {
    case "overage_not_provisioned":
    case "no_limits_configured":
      return of(
        "Claude usage credits are turned off",
        `Fast mode bills your Claude usage credits, never your plan. Turn usage credits on at ${USAGE_PAGE}, ${STANDARD_SPEED_FALLBACK}.`,
        "access",
      );
    case "out_of_credits":
      return of(
        "Your Claude usage credits have run out",
        `Fast mode bills your Claude usage credits, never your plan, and the balance is empty. Add funds or turn on auto-reload at ${USAGE_PAGE}, ${STANDARD_SPEED_FALLBACK}.`,
        "billing",
      );
    case "org_level_disabled_until":
    case "org_spend_cap_reached":
      return of(
        "Claude usage credit limit reached",
        `Fast mode bills your Claude usage credits and this period's spend limit is used up. Raise the limit at ${USAGE_PAGE}, ${STANDARD_SPEED_FALLBACK}.`,
        "billing",
      );
    case "org_level_disabled":
    case "org_service_level_disabled":
      return of(
        "Your organization turned Claude usage credits off",
        `Fast mode needs usage credits. Ask an admin to turn them on, ${STANDARD_SPEED_FALLBACK}.`,
        "access",
      );
    case "member_level_disabled":
      return of(
        "Claude usage credits are off for your account",
        `Fast mode needs usage credits. Ask your organization's admin to turn them on for you, ${STANDARD_SPEED_FALLBACK}.`,
        "access",
      );
    case "seat_tier_level_disabled":
    case "seat_tier_zero_credit_limit":
    case "member_zero_credit_limit":
    case "group_zero_credit_limit":
      return of(
        "Claude usage credits aren't available on your plan",
        `Fast mode needs usage credits, which your seat doesn't include. Ask your admin about access, ${STANDARD_SPEED_FALLBACK}.`,
        "access",
      );
    case "fast_mode_org_disabled":
      return of(
        "Your organization turned fast mode off",
        `An Owner can enable fast mode for the organization, ${STANDARD_SPEED_FALLBACK}.`,
        "access",
      );
    default:
      return of(
        "Fast mode needs Claude usage credits",
        `Fast mode bills your Claude usage credits, never your plan, and Anthropic couldn't charge them. Check usage credits at ${USAGE_PAGE}, ${STANDARD_SPEED_FALLBACK}.`,
        "billing",
      );
  }
}

/** The canonical error message for a fast-mode rejection, e.g. `Fast mode unavailable (out_of_credits): …`. */
export function fastModeRejectionMessage(rejection: FastModeRejection): string {
  return `${FAST_MODE_REJECTION_PREFIX} (${rejection.reason}): ${rejection.headline}.`;
}

/**
 * Recover the rejection from an error message: gg-ai's canonical message, or
 * Anthropic's raw fast-mode wording (when it reaches a caller unnormalized).
 */
export function parseFastModeRejection(message: string): FastModeRejection | undefined {
  const canonical = /fast mode unavailable \(([a-z_]+)\)/i.exec(message);
  if (canonical) return describeFastModeRejection(canonical[1]);
  if (/usage credits are required for fast mode/i.test(message)) {
    return describeFastModeRejection(undefined);
  }
  if (/fast mode (?:has been |is )?disabled by your organization/i.test(message)) {
    return describeFastModeRejection("fast_mode_org_disabled");
  }
  return undefined;
}
